import app from "./app";
import { logger } from "./lib/logger";
import { applyRLSPolicies } from "@workspace/db/rls";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/**
 * Apply PostgreSQL RLS policies at startup (idempotent).
 * This ensures DB-level tenant isolation is always in effect,
 * even after a fresh deployment or DB reset.
 */
async function bootstrap() {
  try {
    await applyRLSPolicies();
    logger.info("PostgreSQL RLS policies applied");
  } catch (err) {
    logger.error({ err }, "Failed to apply RLS policies — server will NOT start");
    process.exit(1);
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
  });
}

bootstrap();
