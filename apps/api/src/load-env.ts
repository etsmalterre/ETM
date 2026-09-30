// Loads the .env files. Imported FIRST by index.ts, as a side-effect import:
// ESM evaluates every static import before the importing module's body, so a
// dotenv.config() call in index.ts ran after module-level constants such as
// IS_WINDOWS (lib/production-trm.ts, lib/sst-shared.ts) had already read
// process.env.DB_BACKEND — a Windows dev API on PostgreSQL then took the
// HFSQL-Windows code paths.
import dotenv from 'dotenv'

const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' }) // fallback / overrides
