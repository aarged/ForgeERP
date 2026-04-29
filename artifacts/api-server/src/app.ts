import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import { WebhookHandlers } from "./lib/webhookHandlers";
import { isStripeConfigured } from "./lib/stripe";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Stripe webhook must be registered BEFORE express.json() to receive raw Buffer
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!isStripeConfigured()) {
      res.status(503).json({ error: "Stripe not configured" });
      return;
    }
    const signature = req.headers["stripe-signature"];
    if (!signature) {
      res.status(400).json({ error: "Missing stripe-signature header" });
      return;
    }
    try {
      const sig = Array.isArray(signature) ? signature[0]! : signature;
      await WebhookHandlers.processWebhook(req.body as Buffer, sig);
      res.status(200).json({ received: true });
    } catch (err) {
      logger.error({ err }, "Stripe webhook error");
      res.status(400).json({ error: "Webhook processing failed" });
    }
  },
);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

/**
 * CORS configuration:
 * - In development: allow the Replit dev domain and localhost
 * - In production: restrict to the configured ALLOWED_ORIGINS env var
 *   or the REPLIT_DOMAINS env var (set by Replit automatically)
 */
const replitDomains = process.env.REPLIT_DOMAINS?.split(",").map((d) => d.trim()) ?? [];
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : [
      "http://localhost:3000",
      "http://localhost:5173",
      ...replitDomains.map((d) => `https://${d}`),
    ];

app.use(
  cors({
    credentials: true,
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.some((allowed) => origin === allowed || origin.endsWith(allowed))) {
        callback(null, true);
      } else if (process.env.NODE_ENV !== "production") {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin '${origin}' not allowed`));
      }
    },
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", router);

export default app;
