import app from "./app";
import { logger } from "./lib/logger";
import { applyRLSPolicies } from "@workspace/db/rls";
import { isStripeConfigured, getStripeSync } from "./lib/stripe";
import { runMigrations } from "stripe-replit-sync";

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
async function initStripe(): Promise<void> {
  if (!isStripeConfigured()) {
    logger.info("Stripe integration not connected — billing features disabled");
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;
  try {
    await runMigrations({ databaseUrl });
    const stripeSync = await getStripeSync();
    const webhookBaseUrl = `https://${process.env.REPLIT_DOMAINS?.split(",")[0]}`;
    await stripeSync.findOrCreateManagedWebhook(`${webhookBaseUrl}/api/stripe/webhook`);
    stripeSync.syncBackfill().catch((err: unknown) => {
      logger.warn({ err }, "Stripe backfill failed (non-fatal)");
    });
    logger.info("Stripe initialized");
  } catch (err) {
    logger.warn({ err }, "Stripe initialization failed — billing features disabled");
  }
}

async function bootstrap() {
  try {
    await applyRLSPolicies();
    logger.info("PostgreSQL RLS policies applied");
  } catch (err) {
    logger.error({ err }, "Failed to apply RLS policies — server will NOT start");
    process.exit(1);
  }

  await initStripe();

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info({ port }, "Server listening");
  });
}

bootstrap();
