/*
 * hfsql_dump - read HFSQL through iODBC for the PostgreSQL migration.
 *
 *   hfsql_dump '<odbc connection string>' catalog
 *       One JSON object per table on stdout:
 *       {"table":"adresse","columns":[{"name":..,"type":-5,"type_name":..,"size":..,
 *        "decimals":..,"nullable":1},...],"pk":["IDADRESSE"]}
 *
 *   hfsql_dump '<odbc connection string>' scalar "<sql>"
 *       First column of the first row, as text (row counts).
 *
 *   hfsql_dump '<odbc connection string>' copy <table> [--text=cp1252|wchar|raw]
 *       SELECT * FROM <table>, streamed to stdout in PostgreSQL COPY text
 *       format (tab separated, \N = NULL, bytea as \\x<hex>). On stderr, one
 *       JSON line with the column header, then one with the stats.
 *
 * Every value is converted explicitly and every anomaly COUNTED, never
 * silently fixed: the orchestrator (pg_migrate.py) turns the counts into
 * issues for the daily review.
 *   - text: a value STARTING with a NUL byte is NULL, as the MPS API reads it
 *     (hfsql-bridge.ts cleanRow): HFSQL stores empty memos / fixed texts that way.
 *     Otherwise cp1252 bytes -> UTF-8 (default). Other NUL bytes cannot live in a
 *     PostgreSQL text value: stripped and counted. Bytes that already form
 *     valid multi-byte UTF-8 are counted too (possible double encoding).
 *   - dates / times / timestamps: fetched as ODBC structs and printed ISO;
 *     an all-zero date (HFSQL "empty date") becomes NULL and is counted; an
 *     impossible one (month 20, 31/02) becomes NULL and is reported per row.
 *   - binary / memo binary: hex.
 *
 * Build (on the PostgreSQL VM): gcc -O2 -o hfsql_dump hfsql_dump.c -I/usr/include/iodbc -liodbc
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sql.h>
#include <sqlext.h>

#define MAX_COLS 512
#define CHUNK 65536

static SQLHENV henv;
static SQLHDBC hdbc;

static void die_diag(SQLSMALLINT type, SQLHANDLE h, const char *what) {
    SQLCHAR state[6], msg[2048];
    SQLINTEGER native;
    SQLSMALLINT len;
    fprintf(stderr, "{\"error\":\"%s", what);
    if (SQLGetDiagRec(type, h, 1, state, &native, msg, sizeof msg, &len) == SQL_SUCCESS) {
        fprintf(stderr, ": [%s] ", state);
        for (SQLCHAR *p = msg; *p; p++) {
            if (*p == '"' || *p == '\\') fputc('\\', stderr);
            fputc((*p == '\n' || *p == '\r' || *p == '\t') ? ' ' : *p, stderr);
        }
    }
    fprintf(stderr, "\"}\n");
    exit(2);
}

/* cp1252 0x80-0x9F -> Unicode (0 = undefined in cp1252) */
static const unsigned short cp1252_hi[32] = {
    0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017D, 0,
    0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178};

static void put_utf8(unsigned int cp) {
    if (cp < 0x80) putchar(cp);
    else if (cp < 0x800) { putchar(0xC0 | (cp >> 6)); putchar(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { putchar(0xE0 | (cp >> 12)); putchar(0x80 | ((cp >> 6) & 0x3F)); putchar(0x80 | (cp & 0x3F)); }
    else { putchar(0xF0 | (cp >> 18)); putchar(0x80 | ((cp >> 12) & 0x3F)); putchar(0x80 | ((cp >> 6) & 0x3F)); putchar(0x80 | (cp & 0x3F)); }
}

/* COPY text escaping of one code point */
static void put_cp(unsigned int cp) {
    switch (cp) {
    case '\\': fputs("\\\\", stdout); return;
    case '\t': fputs("\\t", stdout); return;
    case '\n': fputs("\\n", stdout); return;
    case '\r': fputs("\\r", stdout); return;
    }
    put_utf8(cp);
}

struct stats {
    long rows, nul_as_null, nul_stripped, zero_dates, invalid_dates, utf8_like, undefined_cp1252, bytes;
    long col_nul[MAX_COLS], col_nul_null[MAX_COLS], col_zero_date[MAX_COLS], col_invalid_date[MAX_COLS], col_utf8_like[MAX_COLS];
} st;

/* Does buf[i..] start a valid 2-4 byte UTF-8 sequence? (double-encoding hint) */
static int utf8_seq(const unsigned char *b, size_t n, size_t i) {
    unsigned char c = b[i];
    int need = (c & 0xE0) == 0xC0 ? 1 : (c & 0xF0) == 0xE0 ? 2 : (c & 0xF8) == 0xF0 ? 3 : 0;
    if (!need || c < 0xC2 || i + need >= n) return 0;
    for (int k = 1; k <= need; k++) if ((b[i + k] & 0xC0) != 0x80) return 0;
    return 1;
}

static void emit_text_cp1252(const unsigned char *b, size_t n, int col) {
    for (size_t i = 0; i < n; i++) {
        unsigned char c = b[i];
        if (c == 0) { st.nul_stripped++; st.col_nul[col]++; continue; }
        if (c < 0x80) { put_cp(c); continue; }
        if (utf8_seq(b, n, i)) { st.utf8_like++; st.col_utf8_like[col]++; }
        if (c < 0xA0) {
            unsigned int u = cp1252_hi[c - 0x80];
            if (!u) { st.undefined_cp1252++; u = c; } /* keep as C1 control, counted */
            put_cp(u);
        } else put_cp(c);
    }
}

static int valid_ts(const SQL_TIMESTAMP_STRUCT *t) {
    static const int mdays[] = {31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if (t->month < 1 || t->month > 12 || t->day < 1) return 0;
    int leap = (t->year % 4 == 0 && t->year % 100 != 0) || t->year % 400 == 0;
    int md = t->month == 2 ? (leap ? 29 : 28) : mdays[t->month - 1];
    return t->day <= md && t->hour < 24 && t->minute < 60 && t->second < 60;
}

static void emit_hex(const unsigned char *b, size_t n) {
    static const char hx[] = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) { putchar(hx[b[i] >> 4]); putchar(hx[b[i] & 15]); }
}

static void json_str(FILE *f, const unsigned char *s) {
    fputc('"', f);
    for (; *s; s++) {
        if (*s == '"' || *s == '\\') { fputc('\\', f); fputc(*s, f); }
        else if (*s < 0x20) fprintf(f, "\\u%04x", *s);
        else if (*s < 0x80) fputc(*s, f);
        else { /* names are cp1252 too */
            unsigned int u = *s < 0xA0 ? cp1252_hi[*s - 0x80] : *s;
            if (!u) u = *s;
            if (u < 0x800) { fputc(0xC0 | (u >> 6), f); fputc(0x80 | (u & 0x3F), f); }
            else { fputc(0xE0 | (u >> 12), f); fputc(0x80 | ((u >> 6) & 0x3F), f); fputc(0x80 | (u & 0x3F), f); }
        }
    }
    fputc('"', f);
}

static void connect_db(const char *cs) {
    SQLAllocHandle(SQL_HANDLE_ENV, SQL_NULL_HANDLE, &henv);
    SQLSetEnvAttr(henv, SQL_ATTR_ODBC_VERSION, (void *)SQL_OV_ODBC3, 0);
    SQLAllocHandle(SQL_HANDLE_DBC, henv, &hdbc);
    SQLCHAR out[1024];
    SQLSMALLINT outlen;
    SQLRETURN r = SQLDriverConnect(hdbc, NULL, (SQLCHAR *)cs, SQL_NTS, out, sizeof out, &outlen, SQL_DRIVER_NOPROMPT);
    if (!SQL_SUCCEEDED(r)) die_diag(SQL_HANDLE_DBC, hdbc, "connect");
}

/* ── catalog ─────────────────────────────────────────────── */

static int catalog(void) {
    SQLHSTMT ht;
    SQLAllocHandle(SQL_HANDLE_STMT, hdbc, &ht);
    if (!SQL_SUCCEEDED(SQLTables(ht, NULL, 0, NULL, 0, NULL, 0, (SQLCHAR *)"TABLE", SQL_NTS)))
        die_diag(SQL_HANDLE_STMT, ht, "SQLTables");
    static char names[4096][256];
    int nt = 0;
    SQLCHAR name[256];
    SQLLEN ind;
    while (SQL_SUCCEEDED(SQLFetch(ht)) && nt < 4096) {
        SQLGetData(ht, 3, SQL_C_CHAR, name, sizeof name, &ind);
        if (ind > 0) { strncpy(names[nt], (char *)name, 255); nt++; }
    }
    SQLFreeHandle(SQL_HANDLE_STMT, ht);

    for (int t = 0; t < nt; t++) {
        SQLHSTMT hc;
        SQLAllocHandle(SQL_HANDLE_STMT, hdbc, &hc);
        printf("{\"table\":");
        json_str(stdout, (unsigned char *)names[t]);
        printf(",\"columns\":[");
        if (!SQL_SUCCEEDED(SQLColumns(hc, NULL, 0, NULL, 0, (SQLCHAR *)names[t], SQL_NTS, NULL, 0)))
            die_diag(SQL_HANDLE_STMT, hc, "SQLColumns");
        int first = 1;
        while (SQL_SUCCEEDED(SQLFetch(hc))) {
            SQLCHAR cname[256] = "", tname[128] = "";
            SQLSMALLINT dtype = 0, dec = 0, nullable = 0;
            SQLINTEGER size = 0;
            SQLLEN i1, i2, i3, i4, i5, i6;
            SQLGetData(hc, 4, SQL_C_CHAR, cname, sizeof cname, &i1);
            SQLGetData(hc, 5, SQL_C_SSHORT, &dtype, 0, &i2);
            SQLGetData(hc, 6, SQL_C_CHAR, tname, sizeof tname, &i3);
            SQLGetData(hc, 7, SQL_C_SLONG, &size, 0, &i4);
            SQLGetData(hc, 9, SQL_C_SSHORT, &dec, 0, &i5);
            SQLGetData(hc, 11, SQL_C_SSHORT, &nullable, 0, &i6);
            printf("%s{\"name\":", first ? "" : ",");
            json_str(stdout, cname);
            printf(",\"type\":%d,\"type_name\":", dtype);
            json_str(stdout, tname);
            printf(",\"size\":%d,\"decimals\":%d,\"nullable\":%d}", (int)(i4 == SQL_NULL_DATA ? 0 : size),
                   (int)(i5 == SQL_NULL_DATA ? 0 : dec), nullable);
            first = 0;
        }
        SQLFreeHandle(SQL_HANDLE_STMT, hc);
        printf("],\"pk\":[");
        SQLAllocHandle(SQL_HANDLE_STMT, hdbc, &hc);
        first = 1;
        if (SQL_SUCCEEDED(SQLPrimaryKeys(hc, NULL, 0, NULL, 0, (SQLCHAR *)names[t], SQL_NTS))) {
            while (SQL_SUCCEEDED(SQLFetch(hc))) {
                SQLCHAR cname[256] = "";
                SQLLEN i1;
                SQLGetData(hc, 4, SQL_C_CHAR, cname, sizeof cname, &i1);
                if (!first) putchar(',');
                json_str(stdout, cname);
                first = 0;
            }
        }
        SQLFreeHandle(SQL_HANDLE_STMT, hc);
        printf("]}\n");
    }
    return 0;
}

/* ── copy ────────────────────────────────────────────────── */

static int is_binary(SQLSMALLINT t) { return t == SQL_BINARY || t == SQL_VARBINARY || t == SQL_LONGVARBINARY; }
static int is_date(SQLSMALLINT t) { return t == SQL_TYPE_DATE || t == SQL_DATE; }
static int is_time(SQLSMALLINT t) { return t == SQL_TYPE_TIME || t == SQL_TIME; }
static int is_ts(SQLSMALLINT t) { return t == SQL_TYPE_TIMESTAMP || t == SQL_TIMESTAMP; }
static int is_text(SQLSMALLINT t) {
    return t == SQL_CHAR || t == SQL_VARCHAR || t == SQL_LONGVARCHAR || t == SQL_WCHAR || t == SQL_WVARCHAR || t == SQL_WLONGVARCHAR;
}

static int copy_table(const char *table, const char *textmode) {
    SQLHSTMT hs;
    SQLAllocHandle(SQL_HANDLE_STMT, hdbc, &hs);
    char sql[600];
    snprintf(sql, sizeof sql, "SELECT * FROM %s", table);
    if (!SQL_SUCCEEDED(SQLExecDirect(hs, (SQLCHAR *)sql, SQL_NTS))) die_diag(SQL_HANDLE_STMT, hs, "select");
    SQLSMALLINT ncols;
    SQLNumResultCols(hs, &ncols);
    if (ncols > MAX_COLS) { fprintf(stderr, "{\"error\":\"too many columns\"}\n"); return 2; }
    SQLSMALLINT types[MAX_COLS];
    fprintf(stderr, "{\"header\":[");
    for (int c = 0; c < ncols; c++) {
        SQLCHAR cname[256];
        SQLSMALLINT nlen, dt, dd, nl;
        SQLULEN sz;
        SQLDescribeCol(hs, c + 1, cname, sizeof cname, &nlen, &dt, &sz, &dd, &nl);
        types[c] = dt;
        fprintf(stderr, "%s{\"name\":", c ? "," : "");
        json_str(stderr, cname);
        fprintf(stderr, ",\"type\":%d}", dt);
    }
    fprintf(stderr, "]}\n");

    unsigned char *buf = malloc(CHUNK + 4);
    unsigned char *acc = NULL;
    size_t acc_cap = 0;
    int wchar = strcmp(textmode, "wchar") == 0, raw = strcmp(textmode, "raw") == 0;

    SQLRETURN fr;
    while ((fr = SQLFetch(hs)) != SQL_NO_DATA) {
        if (!SQL_SUCCEEDED(fr)) die_diag(SQL_HANDLE_STMT, hs, "fetch");
        st.rows++;
        for (int c = 0; c < ncols; c++) {
            if (c) putchar('\t');
            SQLSMALLINT t = types[c];
            SQLLEN ind;
            if (is_date(t) || is_ts(t)) {
                SQL_TIMESTAMP_STRUCT ts;
                memset(&ts, 0, sizeof ts);
                SQLRETURN r = SQLGetData(hs, c + 1, SQL_C_TYPE_TIMESTAMP, &ts, sizeof ts, &ind);
                if (!SQL_SUCCEEDED(r)) die_diag(SQL_HANDLE_STMT, hs, "getdata ts");
                if (ind == SQL_NULL_DATA) { fputs("\\N", stdout); continue; }
                if (ts.year == 0) { st.zero_dates++; st.col_zero_date[c]++; fputs("\\N", stdout); continue; }
                if (!valid_ts(&ts)) {
                    /* e.g. month 20: PostgreSQL refuses it and the whole table would fail
                     * to load. NULL it, count it, report the row (1-based) for the review. */
                    st.invalid_dates++;
                    if (st.col_invalid_date[c]++ < 5)
                        fprintf(stderr, "{\"invalid_date\":{\"col\":%d,\"row\":%ld,\"value\":\"%04d-%02d-%02d %02d:%02d:%02d\"}}\n",
                                c, st.rows, ts.year, ts.month, ts.day, ts.hour, ts.minute, ts.second);
                    fputs("\\N", stdout);
                    continue;
                }
                if (is_date(t)) printf("%04d-%02d-%02d", ts.year, ts.month, ts.day);
                else {
                    printf("%04d-%02d-%02d %02d:%02d:%02d", ts.year, ts.month, ts.day, ts.hour, ts.minute, ts.second);
                    if (ts.fraction) printf(".%03u", (unsigned)(ts.fraction / 1000000));
                }
                continue;
            }
            if (is_time(t)) {
                SQL_TIME_STRUCT tm;
                SQLRETURN r = SQLGetData(hs, c + 1, SQL_C_TYPE_TIME, &tm, sizeof tm, &ind);
                if (!SQL_SUCCEEDED(r)) die_diag(SQL_HANDLE_STMT, hs, "getdata time");
                if (ind == SQL_NULL_DATA) { fputs("\\N", stdout); continue; }
                printf("%02d:%02d:%02d", tm.hour, tm.minute, tm.second);
                continue;
            }
            /* Everything else: read the whole value into acc, in chunks. */
            SQLSMALLINT ctype = is_binary(t) ? SQL_C_BINARY : (wchar && is_text(t)) ? SQL_C_WCHAR : SQL_C_CHAR;
            int term = ctype == SQL_C_CHAR ? 1 : ctype == SQL_C_WCHAR ? 2 : 0;
            size_t len = 0;
            int isnull = 0;
            for (;;) {
                SQLRETURN r = SQLGetData(hs, c + 1, ctype, buf, CHUNK, &ind);
                if (r == SQL_NO_DATA) break;
                if (!SQL_SUCCEEDED(r)) die_diag(SQL_HANDLE_STMT, hs, "getdata");
                if (ind == SQL_NULL_DATA) { isnull = 1; break; }
                size_t got = (ind == SQL_NO_TOTAL || ind > CHUNK - term) ? (size_t)(CHUNK - term) : (size_t)ind;
                if (len + got + 4 > acc_cap) { acc_cap = (len + got + 4) * 2; acc = realloc(acc, acc_cap); }
                memcpy(acc + len, buf, got);
                len += got;
                if (r == SQL_SUCCESS) break;
            }
            if (isnull) { fputs("\\N", stdout); continue; }
            st.bytes += len;
            if (ctype != SQL_C_BINARY && !raw && len > 0 && acc[0] == 0 && (ctype == SQL_C_CHAR || (len > 1 && acc[1] == 0))) {
                st.nul_as_null++; st.col_nul_null[c]++; fputs("\\N", stdout); continue;
            }
            if (ctype == SQL_C_BINARY || raw) { fputs("\\\\x", stdout); emit_hex(acc, len); continue; }
            if (ctype == SQL_C_WCHAR) {
                for (size_t i = 0; i + 1 < len; i += 2) {
                    unsigned int u = acc[i] | (acc[i + 1] << 8);
                    if (u == 0) { st.nul_stripped++; st.col_nul[c]++; continue; }
                    put_cp(u);
                }
                continue;
            }
            emit_text_cp1252(acc, len, c);
        }
        putchar('\n');
    }
    fflush(stdout);
    fprintf(stderr, "{\"stats\":{\"rows\":%ld,\"bytes\":%ld,\"nul_as_null\":%ld,\"nul_stripped\":%ld,\"zero_dates\":%ld,\"invalid_dates\":%ld,\"utf8_like\":%ld,\"undefined_cp1252\":%ld,\"by_column\":{",
            st.rows, st.bytes, st.nul_as_null, st.nul_stripped, st.zero_dates, st.invalid_dates, st.utf8_like, st.undefined_cp1252);
    int first = 1;
    for (int c = 0; c < ncols; c++) {
        if (!st.col_nul[c] && !st.col_nul_null[c] && !st.col_zero_date[c] && !st.col_invalid_date[c] && !st.col_utf8_like[c]) continue;
        fprintf(stderr, "%s\"%d\":{\"nul_as_null\":%ld,\"nul\":%ld,\"zero_dates\":%ld,\"invalid_dates\":%ld,\"utf8_like\":%ld}", first ? "" : ",", c,
                st.col_nul_null[c], st.col_nul[c], st.col_zero_date[c], st.col_invalid_date[c], st.col_utf8_like[c]);
        first = 0;
    }
    fprintf(stderr, "}}}\n");
    return 0;
}

static int scalar(const char *sql) {
    SQLHSTMT hs;
    SQLAllocHandle(SQL_HANDLE_STMT, hdbc, &hs);
    if (!SQL_SUCCEEDED(SQLExecDirect(hs, (SQLCHAR *)sql, SQL_NTS))) die_diag(SQL_HANDLE_STMT, hs, "scalar");
    SQLCHAR v[256] = "";
    SQLLEN ind = 0;
    if (SQL_SUCCEEDED(SQLFetch(hs))) SQLGetData(hs, 1, SQL_C_CHAR, v, sizeof v, &ind);
    printf("%s\n", ind == SQL_NULL_DATA ? "" : (char *)v);
    SQLFreeHandle(SQL_HANDLE_STMT, hs);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: hfsql_dump <connstr> catalog | copy <table> [--text=cp1252|wchar|raw]\n"); return 1; }
    connect_db(argv[1]);
    int rc;
    if (strcmp(argv[2], "catalog") == 0) rc = catalog();
    else if (strcmp(argv[2], "scalar") == 0 && argc >= 4) rc = scalar(argv[3]);
    else if (strcmp(argv[2], "copy") == 0 && argc >= 4) {
        const char *mode = "cp1252";
        if (argc >= 5 && strncmp(argv[4], "--text=", 7) == 0) mode = argv[4] + 7;
        rc = copy_table(argv[3], mode);
    } else { fprintf(stderr, "bad arguments\n"); rc = 1; }
    SQLDisconnect(hdbc);
    SQLFreeHandle(SQL_HANDLE_DBC, hdbc);
    SQLFreeHandle(SQL_HANDLE_ENV, henv);
    return rc;
}
