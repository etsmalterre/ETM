#!/usr/bin/env python3
"""HFSQL -> PostgreSQL reload and verification (step 2 of claude_doc/pg_migration.md).

Runs on the PostgreSQL VM (10.10.20.6) as the `postgres` OS user, nightly from its
crontab, and on D-Day for real. Each run:

  1. reads the live HFSQL catalog of every source database and diffs it against
     the previous run (schema drift);
  2. rebuilds the target database from scratch (default `mps_rehearsal`);
  3. per table: counts the rows, streams them with hfsql_dump into a COPY file,
     counts again, loads the file, adds the primary key;
  4. reads every table back out of PostgreSQL and compares it field by field
     with what was extracted (type-aware: 5.10 == 5.1);
  5. turns every anomaly into an ISSUE with a stable id, and matches it against
     the register of known issues (known-issues.json, versioned in the repo).

Nothing is silently fixed: a conversion rule lives either in hfsql_dump.c or
here, and each one has a register entry explaining it. The daily review
(/pg_migration_review) reads runs/latest/report.json.

    sudo -u postgres python3 /opt/pg-migration/pg_migrate.py
        [--target mps_rehearsal] [--only table1,table2] [--keep-files]
"""
import argparse
import collections
import datetime
import decimal
import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, 'hfsql_dump')
KNOWN = os.path.join(HERE, 'known-issues.json')
CONF = '/etc/pg-migration/hfsql.conf'
BASE = '/var/lib/pg-migration'

# HFSQL database -> PostgreSQL schema
SOURCES = [('mps', 'public'), ('pointage', 'pointage')]

# ODBC SQL type (as reported by SQLDescribeCol) -> PostgreSQL type
TYPE_MAP = {
    # R3: one size up, HFSQL integers can be UNSIGNED (ref_echantillon.jauge = 65535 in a
    # 2-byte column). Signed 8-byte IDs stay bigint.
    -7: 'smallint', -6: 'smallint', 5: 'integer', 4: 'bigint', -5: 'bigint',
    2: 'numeric', 3: 'numeric',
    6: 'double precision', 7: 'real', 8: 'double precision',
    1: 'text', 12: 'text', -1: 'text', -8: 'text', -9: 'text', -10: 'text',
    -2: 'bytea', -3: 'bytea', -4: 'bytea',
    9: 'date', 91: 'date', 10: 'time', 92: 'time', 11: 'timestamp', 93: 'timestamp',
}

LOG = None


def log(msg):
    line = f"{datetime.datetime.now():%H:%M:%S} {msg}"
    print(line, flush=True)
    if LOG:
        LOG.write(line + '\n')
        LOG.flush()


def pg_name(name):
    """Decision D2: lowercase, unaccented, unquoted-safe characters."""
    s = unicodedata.normalize('NFKD', name)
    s = ''.join(ch for ch in s if not unicodedata.combining(ch)).lower()
    s = re.sub(r'[^a-z0-9_]', '_', s)
    return ('c_' + s) if s[:1].isdigit() else s


def qi(name):
    return '"' + name.replace('"', '""') + '"'


def psql(db, sql, check=True):
    r = subprocess.run(['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-At', '-c', sql],
                       capture_output=True, text=True)
    if check and r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return r


def hfsql_scalar(cs, sql):
    r = subprocess.run([BIN, cs, 'scalar', sql], capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    v = r.stdout.strip()
    return int(float(v)) if v else 0


# ── issues ───────────────────────────────────────────────────

class Issues:
    def __init__(self):
        self.items = []

    def add(self, kind, severity, schema, table, column=None, count=None, message='', sample=None):
        iid = f"{kind}:{schema}.{table}" + (f".{column}" if column else '')
        self.items.append({'id': iid, 'kind': kind, 'severity': severity, 'schema': schema, 'table': table,
                           'column': column, 'count': count, 'message': message, 'sample': sample})


def load_known():
    try:
        with open(KNOWN) as f:
            return json.load(f)['issues']
    except FileNotFoundError:
        return {}


def classify(items, known):
    """status: new | known (rule / accepted) | regressed (was fixed, came back)."""
    seen_keys = set()
    for it in items:
        match = next((k for k in known if fnmatch.fnmatchcase(it['id'], k)), None)
        if match is None:
            it['status'] = 'new'
        else:
            seen_keys.add(match)
            entry = known[match]
            it['status'] = 'regressed' if entry.get('status') == 'fixed-data' else 'known'
            it['register'] = {'key': match, **entry}
    gone = [k for k, v in known.items() if k not in seen_keys and v.get('status') == 'fixed-data']
    return gone


# ── comparison (round trip) ──────────────────────────────────

def norm(pgtype, v):
    if v == '\\N':
        return None
    if pgtype in ('double precision', 'real'):
        return float(v)
    if pgtype in ('smallint', 'integer', 'bigint'):
        return int(v)  # the driver zero-pads some columns: "0000000000" == 0
    if pgtype == 'numeric':
        return decimal.Decimal(v)
    if pgtype == 'timestamp' and '.' in v:
        head, frac = v.split('.', 1)
        frac = frac.rstrip('0')
        return head + ('.' + frac if frac else '')
    return v


def roundtrip(db, qtable, dump_path, pgtypes, pk_cols, pk_idxs):
    """Compare the COPY file we loaded with what PostgreSQL gives back, row by
    row matched on the primary key (PostgreSQL does not keep load order).
    Without a key: order-independent comparison of whole lines."""
    diffs = {}  # column index -> [count, sample]
    order = ', '.join(qi(c) for c in pk_cols) if pk_cols else '1'
    p = subprocess.Popen(['psql', '-X', '-q', '-d', db, '-c',
                          f"COPY (SELECT * FROM {qtable} ORDER BY {order}) TO STDOUT"], stdout=subprocess.PIPE)
    keyof = lambda line: tuple(line.rstrip(b'\n').split(b'\t')[i] for i in pk_idxs)
    if not pk_cols:
        mine = collections.Counter(hashlib.sha1(l).digest() for l in open(dump_path, 'rb'))
        theirs = collections.Counter(hashlib.sha1(l).digest() for l in p.stdout)
        p.wait()
        return diffs, sum((mine - theirs).values()), sum((theirs - mine).values())
    offsets = {}
    with open(dump_path, 'rb') as src:
        pos = 0
        for line in src:
            offsets[keyof(line)] = pos
            pos += len(line)
    surplus = 0
    with open(dump_path, 'rb') as src:
        for b in p.stdout:
            off = offsets.pop(keyof(b), None)
            if off is None:
                surplus += 1
                continue
            src.seek(off)
            a = src.readline()
            if a == b:
                continue
            fa = a.decode('utf-8', 'replace').rstrip('\n').split('\t')
            fb = b.decode('utf-8', 'replace').rstrip('\n').split('\t')
            for i, t in enumerate(pgtypes):
                va = fa[i] if i < len(fa) else '<absent>'
                vb = fb[i] if i < len(fb) else '<absent>'
                if va == vb:
                    continue
                try:
                    if norm(t, va) == norm(t, vb):
                        continue
                except Exception:
                    pass
                d = diffs.setdefault(i, [0, None])
                d[0] += 1
                if d[1] is None:
                    d[1] = {'key': '/'.join(fa[j] for j in pk_idxs), 'extracted': va[:200], 'postgres': vb[:200]}
    p.wait()
    return diffs, len(offsets), surplus


# ── one table ────────────────────────────────────────────────

def process_table(args, cs, schema, t, work, issues, reserved):
    name = t['table']
    pgt = pg_name(name)
    qtable = f"{qi(schema)}.{qi(pgt)}"
    res = {'schema': schema, 'hfsql_table': name, 'pg_table': pgt, 'status': 'failed'}
    t0 = time.time()
    try:
        before = hfsql_scalar(cs, f"SELECT COUNT(*) FROM {name}")
    except Exception as e:
        issues.add('count_error', 'error', schema, pgt, message=str(e)[:500])
        return res
    dump_path = os.path.join(work, f"{schema}.{pgt}.copy")
    with open(dump_path, 'wb') as out:
        p = subprocess.run([BIN, cs, 'copy', name], stdout=out, stderr=subprocess.PIPE)
    header, stats, err = None, None, None
    invalid = {}  # column index -> [(row number, value)]
    for line in p.stderr.decode('utf-8', 'replace').splitlines():
        try:
            j = json.loads(line)
        except ValueError:
            err = (err or '') + line
            continue
        if 'invalid_date' in j:
            v = j['invalid_date']
            invalid.setdefault(v['col'], []).append((v['row'], v['value']))
        header = j.get('header', header)
        stats = j.get('stats', stats)
        err = j.get('error', err)
    if p.returncode != 0 or header is None or stats is None:
        issues.add('extract_error', 'error', schema, pgt, message=(err or f"exit {p.returncode}")[:500])
        return res
    after = hfsql_scalar(cs, f"SELECT COUNT(*) FROM {name}")

    # Columns. NAMES come from the catalog (SQLColumns): the SELECT * header
    # mangles some of them on this driver, accented or not (qtemin -> "qttran",
    # diametre -> "diame", envoye_client -> "envoyiete"). TYPES come from the
    # header, because hfsql_dump formats each value by that type. The two lists
    # must line up position by position, or the table is refused.
    cat_cols = t['columns']
    aligned = len(cat_cols) == len(header) and all(c['type'] == h['type'] for c, h in zip(cat_cols, header))
    if not aligned:
        issues.add('catalog_mismatch', 'error', schema, pgt,
                   message=f"catalog columns {[(c['name'], c['type']) for c in cat_cols]} do not line up with "
                           f"SELECT * {[(h['name'], h['type']) for h in header]}")
        return res
    cols = []
    for c, h in zip(cat_cols, header):
        pn = pg_name(c['name'])
        pgtype = TYPE_MAP.get(h['type'])
        if pgtype is None:
            issues.add('unknown_type', 'error', schema, pgt, pn, message=f"ODBC type {h['type']} mapped to text")
            pgtype = 'text'
        if pn in reserved:
            issues.add('reserved_name', 'warning', schema, pgt, pn,
                       message=f"« {pn} » is a PostgreSQL reserved word: every query must quote it")
        if not c['name'].isascii():
            issues.add('renamed_column', 'info', schema, pgt, pn, message=f"HFSQL « {c['name']} » becomes « {pn} »")
        cols.append((pn, pgtype, c))
    names = [c[0] for c in cols]
    dup = {n for n in names if names.count(n) > 1}
    if dup:
        issues.add('duplicate_column', 'error', schema, pgt, message=f"columns collide after renaming: {sorted(dup)}")
        return res

    psql(args.target, f"DROP TABLE IF EXISTS {qtable}")
    psql(args.target, f"CREATE TABLE {qtable} (" + ', '.join(f"{qi(c[0])} {c[1]}" for c in cols) + ")")
    r = psql(args.target, f"\\copy {qtable} FROM '{dump_path}'", check=False)
    if r.returncode != 0:
        issues.add('load_error', 'error', schema, pgt, message=r.stderr.strip()[:800])
        return res
    loaded = int(psql(args.target, f"SELECT count(*) FROM {qtable}").stdout.strip())
    res.update(rows=loaded, hfsql_before=before, hfsql_after=after, bytes=stats['bytes'])

    if before != after:
        issues.add('changed_during_copy', 'warning', schema, pgt, count=after - before,
                   message=f"HFSQL had {before} rows before the copy, {after} after")
    elif stats['rows'] != before:
        issues.add('extract_count_mismatch', 'error', schema, pgt,
                   message=f"HFSQL counts {before} rows, the extraction read {stats['rows']}")
    if loaded != stats['rows']:
        issues.add('load_count_mismatch', 'error', schema, pgt,
                   message=f"extracted {stats['rows']} rows, PostgreSQL holds {loaded}")

    # Primary key (catalog names are upper-cased by the driver)
    # Primary key: SQLPrimaryKeys keeps accents that SQLColumns drops (IDASSO_FIL_MATIÈRE)
    names = {c[0] for c in cols}
    pk = [pg_name(n) if pg_name(n) in names else None for n in t.get('pk', [])]
    pk_idx = None
    pk_ok = []  # key columns usable to match rows in the round trip
    if not pk or None in pk:
        issues.add('no_primary_key', 'warning', schema, pgt, message=f"HFSQL declares no usable primary key ({t.get('pk')})")
    else:
        pk_idx = [c[0] for c in cols].index(pk[0])
        r = psql(args.target, f"ALTER TABLE {qtable} ADD PRIMARY KEY (" + ', '.join(qi(c) for c in pk) + ")", check=False)
        if r.returncode == 0:
            pk_ok = pk
        else:
            keys = ', '.join(qi(c) for c in pk)
            d = psql(args.target, f"SELECT count(*) FROM (SELECT {keys} FROM {qtable} GROUP BY {keys} HAVING count(*) > 1) d").stdout.strip()
            s = psql(args.target, f"SELECT {keys}, count(*) FROM {qtable} GROUP BY {keys} HAVING count(*) > 1 ORDER BY 1 LIMIT 5").stdout.strip()
            issues.add('duplicate_pk', 'error', schema, pgt, ','.join(pk), count=int(d or 0),
                       message=f"{d} duplicated key value(s)", sample=s.splitlines())

    # Extraction anomalies, per column
    for idx, c in stats.get('by_column', {}).items():
        cn = cols[int(idx)][0]
        if c.get('nul_as_null'):
            issues.add('nul_as_null', 'info', schema, pgt, cn, count=c['nul_as_null'],
                       message='value starting with a NUL byte loaded as NULL (as the MPS API reads it)')
        if c.get('nul'):
            issues.add('nul_stripped', 'warning', schema, pgt, cn, count=c['nul'],
                       message='NUL bytes inside a text value were removed')
        if c.get('invalid_dates'):
            issues.add('invalid_date', 'error', schema, pgt, cn, count=c['invalid_dates'],
                       message='impossible date in HFSQL (loaded as NULL): fix the row in HFSQL or accept',
                       sample=[{'key': key_of_row(dump_path, row, pk_idx), 'value': val} for row, val in invalid.get(int(idx), [])])
        if c.get('zero_dates'):
            issues.add('zero_date_null', 'info', schema, pgt, cn, count=c['zero_dates'],
                       message='empty HFSQL date (0000-00-00) loaded as NULL')
        if c.get('utf8_like'):
            s = psql(args.target, f"SELECT {qi(cols[pk_idx][0]) if pk_idx is not None else 'NULL'}, regexp_replace(left({qi(cn)}, 80), '\\s+', ' ', 'g') "
                                  f"FROM {qtable} WHERE {qi(cn)} ~ '[ÃÂ][^A-Za-z0-9 ]' LIMIT 3",
                     check=False).stdout.strip()
            issues.add('possible_double_encoding', 'warning', schema, pgt, cn, count=c['utf8_like'],
                       message='bytes that look like UTF-8 stored as cp1252 (mojibake such as « Ã© »)',
                       sample=s.splitlines() or None)
    if stats.get('undefined_cp1252'):
        issues.add('undefined_cp1252', 'warning', schema, pgt, count=stats['undefined_cp1252'],
                   message='bytes with no cp1252 meaning (0x81, 0x8D, 0x8F, 0x90, 0x9D) kept as control characters')

    # Round trip: what PostgreSQL holds == what we extracted
    diffs, missing, surplus = roundtrip(args.target, qtable, dump_path, [c[1] for c in cols],
                                        pk_ok, [[c[0] for c in cols].index(k) for k in pk_ok])
    for idx, (n, sample) in diffs.items():
        issues.add('roundtrip_mismatch', 'error', schema, pgt, cols[idx][0], count=n,
                   message='PostgreSQL gives back a different value than the one extracted', sample=sample)
    if missing or surplus:
        issues.add('roundtrip_rowcount', 'error', schema, pgt,
                   message=f"{missing} extracted row(s) missing in PostgreSQL, {surplus} extra")

    res.update(status='ok', seconds=round(time.time() - t0, 1))
    if not args.keep_files:
        os.remove(dump_path)
    return res


def key_of_row(dump_path, row, idx):
    """Primary-key value of the 1-based row of a COPY file (review samples)."""
    if idx is None:
        return f"row {row}"
    with open(dump_path, 'rb') as f:
        for n, line in enumerate(f, 1):
            if n == row:
                return line.split(b'\t')[idx].decode()
    return f"row {row}"


# ── catalog drift ────────────────────────────────────────────

def catalog_drift(prev, cur, schema, issues):
    p = {t['table']: t for t in prev}
    c = {t['table']: t for t in cur}
    for n in sorted(set(c) - set(p)):
        issues.add('table_added', 'info', schema, pg_name(n), message=f"new HFSQL table « {n} »")
    for n in sorted(set(p) - set(c)):
        issues.add('table_removed', 'warning', schema, pg_name(n), message=f"HFSQL table « {n} » disappeared")
    for n in sorted(set(p) & set(c)):
        pc = {x['name']: x for x in p[n]['columns']}
        cc = {x['name']: x for x in c[n]['columns']}
        for col in sorted(set(cc) - set(pc)):
            issues.add('column_added', 'info', schema, pg_name(n), pg_name(col), message=f"new column {cc[col]}")
        for col in sorted(set(pc) - set(cc)):
            issues.add('column_removed', 'warning', schema, pg_name(n), pg_name(col), message='column disappeared')
        for col in sorted(set(pc) & set(cc)):
            if (pc[col]['type'], pc[col]['size']) != (cc[col]['type'], cc[col]['size']):
                issues.add('column_changed', 'warning', schema, pg_name(n), pg_name(col),
                           message=f"{pc[col]['type']}/{pc[col]['size']} -> {cc[col]['type']}/{cc[col]['size']}")


# ── report ───────────────────────────────────────────────────

def write_report(run_dir, report):
    with open(os.path.join(run_dir, 'report.json'), 'w') as f:
        json.dump(report, f, indent=1, ensure_ascii=False)
    with open(os.path.join(run_dir, 'summary.json'), 'w') as f:
        json.dump(report['summary'], f, ensure_ascii=False)
    s = report['summary']
    lines = [f"# Run {report['run']} → {report['target']}", '',
             f"{s['tables_ok']}/{s['tables']} tables loaded, {s['rows']} rows, {s['duration_min']} min. "
             f"New issues: {s['new']}, regressed: {s['regressed']}, known: {s['known']}, "
             f"open errors: {s['open_errors']}.", '']
    for status in ('regressed', 'new'):
        items = [i for i in report['issues'] if i['status'] == status]
        if items:
            lines += [f"## {status.upper()} ({len(items)})", '']
            for i in sorted(items, key=lambda x: ('error', 'warning', 'info').index(x['severity'])):
                lines.append(f"- **{i['severity']}** `{i['id']}` ×{i['count'] if i['count'] is not None else ''} {i['message']}")
                if i.get('sample'):
                    lines.append(f"  sample: `{json.dumps(i['sample'], ensure_ascii=False)[:300]}`")
            lines.append('')
    if report['gone']:
        lines += ['## Fixed and not seen any more', ''] + [f"- `{k}`" for k in report['gone']] + ['']
    known = [i for i in report['issues'] if i['status'] == 'known']
    lines += [f"## Known ({len(known)}), by register entry", '']
    by_key = {}
    for i in known:
        by_key.setdefault(i['register']['key'], []).append(i)
    for k, v in sorted(by_key.items()):
        lines.append(f"- `{k}` ({v[0]['register'].get('status')}): {len(v)} occurrence(s)")
    lines += ['', '## Slowest tables', '']
    for t in sorted(report['tables'], key=lambda x: -x.get('seconds', 0))[:10]:
        lines.append(f"- {t['schema']}.{t['pg_table']}: {t.get('seconds')} s, {t.get('rows')} rows")
    with open(os.path.join(run_dir, 'report.md'), 'w') as f:
        f.write('\n'.join(lines) + '\n')


def main():
    global LOG
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', default='mps_rehearsal')
    ap.add_argument('--only', help='comma-separated HFSQL table names (keeps the rest of the target)')
    ap.add_argument('--keep-files', action='store_true')
    args = ap.parse_args()
    if args.target == 'mps' and not os.environ.get('PG_MIGRATE_DDAY'):
        sys.exit('refusing to write the production database `mps` without PG_MIGRATE_DDAY=1')

    started = datetime.datetime.now()
    run = started.strftime('%Y-%m-%d_%H%M')
    run_dir = os.path.join(BASE, 'runs', run)
    work = os.path.join(BASE, 'work')
    os.makedirs(run_dir, exist_ok=True)
    os.makedirs(work, exist_ok=True)
    LOG = open(os.path.join(run_dir, 'run.log'), 'w')
    only = set(x.strip().lower() for x in args.only.split(',')) if args.only else None
    log(f"run {run} → {args.target}" + (f" (only {sorted(only)})" if only else ''))

    with open(CONF) as f:
        base_cs = f.read().strip()
    issues = Issues()
    tables = []
    if not only:
        psql('postgres', f"DROP DATABASE IF EXISTS {qi(args.target)} WITH (FORCE)")
        psql('postgres', f"CREATE DATABASE {qi(args.target)}")
    reserved = set(psql(args.target, "SELECT word FROM pg_get_keywords() WHERE catcode IN ('R','T')").stdout.split())

    for hdb, schema in SOURCES:
        cs = re.sub(r'Database=[^;]*', f'Database={hdb}', base_cs)
        r = subprocess.run([BIN, cs, 'catalog'], capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            issues.add('catalog_error', 'error', schema, '*', message=r.stderr.strip()[:500])
            continue
        catalog = [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
        with open(os.path.join(run_dir, f'catalog_{hdb}.json'), 'w') as f:
            json.dump(catalog, f, ensure_ascii=False)
        last = os.path.join(BASE, f'last_catalog_{hdb}.json')
        if os.path.exists(last) and not only:
            with open(last) as f:
                catalog_drift(json.load(f), catalog, schema, issues)
        if schema != 'public':
            psql(args.target, f"CREATE SCHEMA IF NOT EXISTS {qi(schema)}")
        log(f"{hdb}: {len(catalog)} tables")
        for t in sorted(catalog, key=lambda x: x['table']):
            if only and t['table'].lower() not in only:
                continue
            if '/' in t['table'] or '\\' in t['table']:
                # HFSQL backup copies (_backup/Sauvegarde des données de …) are listed
                # as tables of the database: never migrated (rule R4).
                issues.add('skipped_backup', 'info', schema, pg_name(t['table'].split('/')[0]),
                           message=f"HFSQL backup copy « {t['table']} » not migrated")
                continue
            try:
                res = process_table(args, cs, schema, t, work, issues, reserved)
            except Exception as e:
                issues.add('crash', 'error', schema, pg_name(t['table']), message=str(e)[:800])
                res = {'schema': schema, 'hfsql_table': t['table'], 'pg_table': pg_name(t['table']), 'status': 'failed'}
            tables.append(res)
            log(f"  {schema}.{res['pg_table']}: {res['status']} {res.get('rows', '')} rows {res.get('seconds', '')} s")
        if not only:
            shutil.copyfile(os.path.join(run_dir, f'catalog_{hdb}.json'), last)

    gone = classify(issues.items, load_known())
    items = issues.items
    open_err = [i for i in items if i['severity'] == 'error' and i['status'] != 'known']
    summary = {
        'run': run, 'target': args.target, 'partial': bool(only),
        'tables': len(tables), 'tables_ok': sum(t['status'] == 'ok' for t in tables),
        'rows': sum(t.get('rows', 0) for t in tables),
        'duration_min': round((datetime.datetime.now() - started).total_seconds() / 60, 1),
        'new': sum(i['status'] == 'new' for i in items),
        'regressed': sum(i['status'] == 'regressed' for i in items),
        'known': sum(i['status'] == 'known' for i in items),
        'open_errors': len(open_err),
        'gone': len(gone),
    }
    write_report(run_dir, {'run': run, 'target': args.target, 'started': started.isoformat(timespec='seconds'),
                           'summary': summary, 'tables': tables, 'issues': items, 'gone': gone})
    latest = os.path.join(BASE, 'runs', 'latest')
    if not only:
        if os.path.islink(latest):
            os.remove(latest)
        os.symlink(run_dir, latest)
    log(f"done: {json.dumps(summary)}")


if __name__ == '__main__':
    main()
