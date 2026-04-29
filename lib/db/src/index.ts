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
 * Application DB pool uses the `forge_app` role (no BYPASSRLS) so that
 * PostgreSQL RLS policies are enforced for all tenant-scoped queries.
 *
 * Connection URL is built from DATABASE_URL + FORGE_APP_DB_PASSWORD secret:
 *   DATABASE_URL  → postgresql://postgres:<pw>@host/db?...
 *   App URL       → postgresql://forge_app:<FORGE_APP_DB_PASSWORD>@host/db?...
 *
 * Falls back to DATABASE_URL if FORGE_APP_DB_PASSWORD is not set (dev/CI).
 * adminPool always uses DATABASE_URL (superuser) for RLS setup and bootstrap queries.
 */
function buildAppDbUrl(): string {
  const password = process.env.FORGE_APP_DB_PASSWORD;
  if (!password) return process.env.DATABASE_URL!;
  return process.env.DATABASE_URL!.replace(/\/\/[^:]*:[^@]*@/, `//forge_app:${password}@`);
}

const appDbUrl = buildAppDbUrl();

export const pool = new Pool({ connectionString: appDbUrl });
export const adminPool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

/** Creates a new Pool using the app-user connection string (RLS enforced). */
export function createAppPool() {
  return new Pool({ connectionString: appDbUrl });
}

export * from "./schema";
