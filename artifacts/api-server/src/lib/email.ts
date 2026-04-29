import nodemailer from "nodemailer";
import { logger } from "./logger";

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

function isEmailConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function createTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST!,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER!,
      pass: process.env.SMTP_PASS!,
    },
  });
}

export async function sendEmail(opts: EmailOptions): Promise<boolean> {
  if (!isEmailConfigured()) {
    logger.info({ to: opts.to, subject: opts.subject }, "[email] SMTP not configured — skipping send");
    return false;
  }
  try {
    const transporter = createTransport();
    const from = process.env.SMTP_FROM ?? `"Forge ERP" <noreply@${process.env.SMTP_HOST}>`;
    await transporter.sendMail({ from, ...opts });
    logger.info({ to: opts.to, subject: opts.subject }, "[email] Sent successfully");
    return true;
  } catch (err) {
    logger.warn({ err, to: opts.to, subject: opts.subject }, "[email] Failed to send email");
    return false;
  }
}

export function buildWelcomeEmail(opts: {
  firstName: string | null;
  companyName: string;
  planTier: string;
  loginUrl: string;
}): { subject: string; html: string; text: string } {
  const greeting = opts.firstName ? `Hi ${opts.firstName}` : "Hi there";
  const subject = `Welcome to Forge ERP — ${opts.companyName} is ready`;
  const text = `${greeting},\n\nYour Forge ERP workspace for ${opts.companyName} is now active on the ${opts.planTier} plan.\n\nLog in at: ${opts.loginUrl}\n\nIf you need help, reply to this email or visit our docs.\n\nThe Forge ERP Team`;
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:sans-serif;background:#f8fafc;padding:32px;margin:0">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden">
    <div style="background:linear-gradient(135deg,#f97316,#ea580c);padding:24px 32px">
      <span style="color:#fff;font-size:22px;font-weight:700;letter-spacing:-0.5px">Forge ERP</span>
    </div>
    <div style="padding:32px">
      <p style="font-size:16px;color:#1e293b;margin-top:0">${greeting},</p>
      <p style="font-size:15px;color:#475569;line-height:1.6">
        Your Forge ERP workspace for <strong>${opts.companyName}</strong> is now active on the
        <strong style="color:#f97316;text-transform:capitalize">${opts.planTier}</strong> plan.
      </p>
      <p style="font-size:15px;color:#475569;line-height:1.6">
        Your data has been imported and your team is ready to go. Start by creating your first
        purchase order, checking inventory levels, or reviewing your financials.
      </p>
      <div style="margin:28px 0;text-align:center">
        <a href="${opts.loginUrl}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px">
          Open Forge ERP &rarr;
        </a>
      </div>
      <p style="font-size:13px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:20px;margin-bottom:0">
        Questions? Reply to this email or visit our help docs.<br>
        The Forge ERP Team
      </p>
    </div>
  </div>
</body>
</html>`.trim();
  return { subject, html, text };
}
