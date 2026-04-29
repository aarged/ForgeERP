import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

/**
 * Application DB pool.
 *
 * In production, use FORGE_APP_DB_URL to connect with the `forge_app` role
 * which does NOT have BYPASSRLS privilege. This ensures PostgreSQL RLS policies
 * are fully enforced at the DB level for all application queries.
 *
 * DATABASE_URL (typically postgres superuser) is reserved for admin operations
 * such as schema migrations and setup scripts.
 *
 * To set up: create the forge_app role and set FORGE_APP_DB_URL to:
 *   postgresql://forge_app:<password>@<host>/<db>?sslmode=disable
 */
const appDbUrl = process.env.FORGE_APP_DB_URL ?? process.env.DATABASE_URL;

export const pool = new Pool({ connectionString: appDbUrl });
export const adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

/**
 * Creates a new pg.Pool with the app-user connection string.
 * Use this in tests or tools that need a dedicated pool that enforces RLS.
 */
export function createAppPool() {
  return new Pool({ connectionString: appDbUrl });
}

export * from "./schema";
