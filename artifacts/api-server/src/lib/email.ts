import nodemailer from "nodemailer";
import { logger } from "./logger";

interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: EmailAttachment[];
}

export function isEmailConfigured(): boolean {
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
    const { attachments, ...rest } = opts;
    await transporter.sendMail({
      from,
      ...rest,
      attachments: attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    logger.info({ to: opts.to, subject: opts.subject }, "[email] Sent successfully");
    return true;
  } catch (err) {
    logger.warn({ err, to: opts.to, subject: opts.subject }, "[email] Failed to send email");
    return false;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ROLE_LABELS: Record<string, string> = {
  tenant_admin: "Workspace Admin",
  purchaser: "Purchaser",
  warehouse: "Warehouse",
  approver: "Approver",
  accountant: "Accountant",
  viewer: "Viewer",
};

export function buildInviteSignUpUrl(baseSignUpUrl: string, inviteeEmail: string): string {
  try {
    const url = new URL(baseSignUpUrl);
    url.searchParams.set("email_address", inviteeEmail);
    return url.toString();
  } catch {
    const sep = baseSignUpUrl.includes("?") ? "&" : "?";
    return `${baseSignUpUrl}${sep}email_address=${encodeURIComponent(inviteeEmail)}`;
  }
}

export function buildInviteEmail(opts: {
  inviteeEmail: string;
  inviterName: string | null;
  inviterEmail: string;
  companyName: string;
  role: string;
  signUpUrl: string;
}): { subject: string; html: string; text: string } {
  const inviter = opts.inviterName?.trim() || opts.inviterEmail;
  const roleLabel = ROLE_LABELS[opts.role] ?? opts.role;
  const subject = `${inviter} invited you to join ${opts.companyName} on Forge ERP`;
  const text = `Hi,

${inviter} (${opts.inviterEmail}) has invited you to join ${opts.companyName} on Forge ERP as ${roleLabel}.

Click the link below to create your account and accept the invitation:
${opts.signUpUrl}

Your account will be created with the email ${opts.inviteeEmail}. The invite is tied to that address — sign up with the same email so you're added to the workspace automatically.

If you weren't expecting this email, you can safely ignore it.

The Forge ERP Team`;

  const safeInviter = escapeHtml(inviter);
  const safeInviterEmail = escapeHtml(opts.inviterEmail);
  const safeCompany = escapeHtml(opts.companyName);
  const safeRole = escapeHtml(roleLabel);
  const safeInvitee = escapeHtml(opts.inviteeEmail);
  const safeUrl = escapeHtml(opts.signUpUrl);

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
      <p style="font-size:16px;color:#1e293b;margin-top:0">Hi,</p>
      <p style="font-size:15px;color:#475569;line-height:1.6">
        <strong>${safeInviter}</strong> (${safeInviterEmail}) has invited you to join
        <strong>${safeCompany}</strong> on Forge ERP as
        <strong style="color:#f97316">${safeRole}</strong>.
      </p>
      <div style="margin:28px 0;text-align:center">
        <a href="${safeUrl}" style="display:inline-block;background:#f97316;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:15px">
          Accept invitation &rarr;
        </a>
      </div>
      <p style="font-size:13px;color:#64748b;line-height:1.6">
        Your account will be created with the email <strong>${safeInvitee}</strong>.
        The invitation is tied to that address — sign up with the same email so you're
        added to the workspace automatically.
      </p>
      <p style="font-size:13px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:20px;margin-bottom:0">
        Didn't expect this email? You can safely ignore it.<br>
        The Forge ERP Team
      </p>
    </div>
  </div>
</body>
</html>`.trim();

  return { subject, html, text };
}

interface InviteSummaryItem {
  email: string;
  role: string;
  delivered: boolean;
  reason?: string;
}

export function buildInviteSummaryEmail(opts: {
  inviterFirstName: string | null;
  companyName: string;
  results: InviteSummaryItem[];
  settingsUrl: string;
}): { subject: string; html: string; text: string } {
  const greeting = opts.inviterFirstName ? `Hi ${opts.inviterFirstName}` : "Hi there";
  const sent = opts.results.filter((r) => r.delivered);
  const failed = opts.results.filter((r) => !r.delivered);
  const total = opts.results.length;

  const subject =
    failed.length === 0
      ? `${sent.length} team ${sent.length === 1 ? "invite" : "invites"} sent for ${opts.companyName}`
      : `${sent.length} of ${total} team invites sent for ${opts.companyName} — ${failed.length} need attention`;

  const renderRow = (r: InviteSummaryItem) => {
    const status = r.delivered ? "Sent" : "Failed";
    const reason = r.delivered ? "" : ` — ${r.reason ?? "Unknown error"}`;
    return `  • ${r.email} (${ROLE_LABELS[r.role] ?? r.role}) — ${status}${reason}`;
  };

  const text = `${greeting},

Here is a summary of the team invitations sent for ${opts.companyName} on Forge ERP:

Successfully delivered (${sent.length}):
${sent.length === 0 ? "  (none)" : sent.map(renderRow).join("\n")}

${failed.length > 0 ? `Could not deliver (${failed.length}):
${failed.map(renderRow).join("\n")}

You can resend any failed invitations from your workspace settings:
${opts.settingsUrl}` : `All invitations were delivered successfully.`}

The Forge ERP Team`;

  const renderRowHtml = (r: InviteSummaryItem) => {
    const safeEmail = escapeHtml(r.email);
    const safeRole = escapeHtml(ROLE_LABELS[r.role] ?? r.role);
    if (r.delivered) {
      return `<tr><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#1e293b">${safeEmail}</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b">${safeRole}</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#059669">✓ Sent</td></tr>`;
    }
    const safeReason = escapeHtml(r.reason ?? "Unknown error");
    return `<tr><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#1e293b">${safeEmail}</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#64748b">${safeRole}</td><td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#dc2626">✗ ${safeReason}</td></tr>`;
  };

  const safeCompany = escapeHtml(opts.companyName);
  const safeSettingsUrl = escapeHtml(opts.settingsUrl);

  const failedSection = failed.length > 0 ? `
      <div style="margin:20px 0;padding:16px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px">
        <p style="margin:0 0 8px;font-size:14px;color:#991b1b;font-weight:600">${failed.length} ${failed.length === 1 ? "invite" : "invites"} could not be delivered</p>
        <p style="margin:0 0 12px;font-size:13px;color:#7f1d1d;line-height:1.5">
          Open your workspace settings to retry these from the Pending Invites list.
        </p>
        <a href="${safeSettingsUrl}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;font-size:13px">
          Resend from Settings &rarr;
        </a>
      </div>` : `
      <div style="margin:20px 0;padding:16px;background:#ecfdf5;border:1px solid #bbf7d0;border-radius:8px;font-size:14px;color:#166534">
        All invitations were delivered successfully.
      </div>`;

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
      <p style="font-size:16px;color:#1e293b;margin-top:0">${escapeHtml(greeting)},</p>
      <p style="font-size:15px;color:#475569;line-height:1.6">
        Here is a summary of the team invitations sent for
        <strong>${safeCompany}</strong>:
      </p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden">
        <thead>
          <tr style="background:#f8fafc">
            <th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#64748b;letter-spacing:0.04em">Invitee</th>
            <th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#64748b;letter-spacing:0.04em">Role</th>
            <th style="padding:10px 12px;text-align:left;font-size:12px;text-transform:uppercase;color:#64748b;letter-spacing:0.04em">Status</th>
          </tr>
        </thead>
        <tbody>
          ${opts.results.map(renderRowHtml).join("")}
        </tbody>
      </table>
      ${failedSection}
      <p style="font-size:13px;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:20px;margin-bottom:0">
        The Forge ERP Team
      </p>
    </div>
  </div>
</body>
</html>`.trim();

  return { subject, html, text };
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
