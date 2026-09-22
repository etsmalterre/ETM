#!/usr/bin/env python3
"""HFSQL connection sampler, runs on the HFSQL server (10.10.20.2) from the
debian user's crontab every 2 minutes, until the PostgreSQL cutover.

Appends one line per client IP connected to port 4900 to
~/hfsql-audit/samples/YYYY-MM-DD.tsv:  HH:MM <tab> ip <tab> connections <tab> netbios name
The HFSQL server keeps no connection log of its own (ServerLogPath is empty),
so this is the only record of READ-ONLY legacy use; the __jnl journal only sees
writes. Read by legacy-activity-report.ts on the API server through serve.sh.
"""
import datetime, json, os, socket, struct, subprocess

BASE = os.path.expanduser('~/hfsql-audit')
SAMPLES = os.path.join(BASE, 'samples')
NAMES = os.path.join(BASE, 'names.json')
KEEP_DAYS = 200


def netbios_name(ip, timeout=1.0):
    """NBSTAT query (UDP 137). Windows PCs answer with their name; tablets and
    Linux servers don't, the report falls back on the journal's jnl_users."""
    q = struct.pack('>HHHHHH', 0x4d50, 0, 1, 0, 0, 0) + b'\x20' + b'CK' + b'A' * 30 + b'\x00' + struct.pack('>HH', 0x21, 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        s.sendto(q, (ip, 137))
        d, _ = s.recvfrom(2048)
        for i in range(d[56]):
            e = d[57 + i * 18: 57 + (i + 1) * 18]
            if e[15] == 0:
                return e[:15].decode('latin1').strip()
    except Exception:
        pass
    finally:
        s.close()
    return ''


def main():
    os.makedirs(SAMPLES, exist_ok=True)
    now = datetime.datetime.now()
    out = subprocess.run(['ss', '-Htn', 'state', 'established', '( sport = :4900 )'],
                         capture_output=True, text=True, check=True).stdout
    counts = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 4:
            ip = parts[3].rsplit(':', 1)[0].strip('[]').replace('::ffff:', '')
            counts[ip] = counts.get(ip, 0) + 1

    # Name cache, refreshed once per IP per day (DHCP moves PCs around).
    try:
        with open(NAMES) as f:
            names = json.load(f)
    except Exception:
        names = {}
    today = now.strftime('%Y-%m-%d')
    for ip in counts:
        entry = names.get(ip)
        if not entry or entry.get('day') != today:
            names[ip] = {'day': today, 'name': netbios_name(ip) if ip.startswith('10.10.2.') else ''}
    with open(NAMES + '.tmp', 'w') as f:
        json.dump(names, f)
    os.replace(NAMES + '.tmp', NAMES)

    with open(os.path.join(SAMPLES, today + '.tsv'), 'a') as f:
        for ip, n in sorted(counts.items()):
            f.write(f"{now:%H:%M}\t{ip}\t{n}\t{names[ip]['name']}\n")
        if not counts:
            f.write(f"{now:%H:%M}\t-\t0\t\n")

    cutoff = (now - datetime.timedelta(days=KEEP_DAYS)).strftime('%Y-%m-%d')
    for fn in os.listdir(SAMPLES):
        if fn.endswith('.tsv') and fn[:10] < cutoff:
            os.remove(os.path.join(SAMPLES, fn))


if __name__ == '__main__':
    main()
