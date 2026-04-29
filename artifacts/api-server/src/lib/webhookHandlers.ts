import { getStripeSync } from "./stripe";

export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        "Webhook payload must be a Buffer. Ensure webhook route is registered before express.json().",
      );
    }
    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);
  }
}
