-- One-time setup of the `mps_owner` role (decision 2026-09-30, user
-- management plan): the owner of every table of the `mps` database, used ONLY
-- by scripts/mps-migrate.ts (MPS_PG_OWNER_URL) to apply schema migrations.
-- The API keeps its DML-only role (mps_api_prod), which owns nothing.
--
-- Run as postgres on 10.10.20.6, in the target database:
--   sudo -u postgres psql -d mps -v ON_ERROR_STOP=1 \
--     -v owner_pw="'<password>'" -v api_role=mps_api_prod -v ro_role=mps_api \
--     -f mps-owner-setup.sql
-- Idempotent. Takes a brief ACCESS EXCLUSIVE lock per table (ALTER … OWNER):
-- run it with the API stopped, like the migrations that follow.

SET lock_timeout = '5s';

SELECT format('CREATE ROLE mps_owner LOGIN PASSWORD %s', :'owner_pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mps_owner') \gexec
ALTER ROLE mps_owner LOGIN PASSWORD :owner_pw;

SELECT format('GRANT CONNECT ON DATABASE %I TO mps_owner', current_database()) \gexec
GRANT USAGE, CREATE ON SCHEMA public TO mps_owner;
GRANT USAGE, CREATE ON SCHEMA pointage TO mps_owner;

-- Hand over every table, sequence and view of the two application schemas.
SELECT format('ALTER TABLE %I.%I OWNER TO mps_owner', schemaname, tablename)
FROM pg_tables WHERE schemaname IN ('public', 'pointage') AND tableowner <> 'mps_owner' \gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO mps_owner', sequence_schema, sequence_name)
FROM information_schema.sequences s
WHERE sequence_schema IN ('public', 'pointage')
  AND NOT EXISTS (  -- identity sequences follow their table
    SELECT 1 FROM pg_depend d JOIN pg_class c ON c.oid = d.objid
    WHERE c.relname = s.sequence_name AND d.deptype = 'i') \gexec
SELECT format('ALTER VIEW %I.%I OWNER TO mps_owner', schemaname, viewname)
FROM pg_views WHERE schemaname IN ('public', 'pointage') AND viewowner <> 'mps_owner' \gexec

-- Tables the owner creates later are granted to the API roles automatically.
ALTER DEFAULT PRIVILEGES FOR ROLE mps_owner IN SCHEMA public, pointage
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :api_role;
ALTER DEFAULT PRIVILEGES FOR ROLE mps_owner IN SCHEMA public, pointage
  GRANT USAGE, SELECT ON SEQUENCES TO :api_role;
ALTER DEFAULT PRIVILEGES FOR ROLE mps_owner IN SCHEMA public, pointage
  GRANT SELECT ON TABLES TO :ro_role;

-- Check: nothing left to postgres, and the API role still reads/writes.
SELECT schemaname, tableowner, count(*) FROM pg_tables
WHERE schemaname IN ('public', 'pointage') GROUP BY 1, 2 ORDER BY 1, 2;
SELECT count(*) AS tables_api_can_write FROM information_schema.table_privileges
WHERE grantee = :'api_role' AND privilege_type = 'INSERT' AND table_schema IN ('public', 'pointage');
