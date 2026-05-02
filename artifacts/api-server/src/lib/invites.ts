import type { Request } from "express";
import { createClerkClient } from "@clerk/express";
import { logger } from "./logger";
import {
  sendEmail,
  buildInviteEmail,
  buildInviteSignUpUrl,
  isEmailConfigured,
} from "./email";

export const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

export function pendingClerkIdForEmail(email: string): string {
  return `pending:${email.toLowerCase()}`;
}

export function isPendingClerkId(clerkId: string): boolean {
  return clerkId.startsWith("pending:");
}

export interface InviteDeliveryResult {
  email: string;
  role: string;
  delivered: boolean;
  reason?: string;
  clerkInvitationId?: string;
}

function buildAllowedOrigins(): string[] {
  const out = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    try {
      out.add(new URL(raw).origin);
    } catch {
      /* ignore */
    }
  };
  add(process.env.FRONTEND_URL);
  for (const v of (process.env.FRONTEND_URLS ?? "").split(",")) add(v.trim());
  if (process.env.REPLIT_DEV_DOMAIN) {
    add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
  }
  return [...out];
}

/**
 * Resolve a sign-up base URL for invite links from the inbound request.
 * Prefers the request's Origin/Referer when allow-listed, then falls back
 * to FRONTEND_URL.
 */
export function resolveInviteRedirectUrl(req: Request): string | undefined {
  const allowed = buildAllowedOrigins();
  const candidates: string[] = [];
  if (req.headers.origin) candidates.push(req.headers.origin as string);
  if (req.headers.referer) {
    try {
      candidates.push(new URL(req.headers.referer as string).origin);
    } catch {
      /* ignore */
    }
  }
  let chosenOrigin: string | undefined;
  for (const c of candidates) {
    if (allowed.includes(c)) {
      chosenOrigin = c;
      break;
    }
  }
  if (!chosenOrigin && allowed.length > 0 && process.env.FRONTEND_URL) {
    try {
      chosenOrigin = new URL(process.env.FRONTEND_URL).origin;
    } catch {
      /* ignore */
    }
  }
  if (!chosenOrigin) return undefined;
  try {
    return new URL("/sign-up", chosenOrigin).toString();
  } catch {
    return undefined;
  }
}

export const TENANT_ROLES = [
  "tenant_admin",
  "purchaser",
  "warehouse",
  "approver",
  "accountant",
  "viewer",
] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

/**
 * Resolve a Forge ERP settings URL for the inviting admin so summary
 * emails can deep-link to the Pending Invites section.
 */
export function resolveSettingsUrl(req: Request): string | undefined {
  const allowed = buildAllowedOrigins();
  const candidates: string[] = [];
  if (req.headers.origin) candidates.push(req.headers.origin as string);
  if (req.headers.referer) {
    try {
      candidates.push(new URL(req.headers.referer as string).origin);
    } catch {
      /* ignore */
    }
  }
  let chosenOrigin: string | undefined;
  for (const c of candidates) {
    if (allowed.includes(c)) {
      chosenOrigin = c;
      break;
    }
  }
  if (!chosenOrigin && allowed.length > 0 && process.env.FRONTEND_URL) {
    try {
      chosenOrigin = new URL(process.env.FRONTEND_URL).origin;
    } catch {
      /* ignore */
    }
  }
  if (!chosenOrigin) return undefined;
  try {
    return new URL("/forge-erp/settings", chosenOrigin).toString();
  } catch {
    return undefined;
  }
}

/**
 * Deliver branded invite emails for a batch of pending memberships.
 *
 * For each invite we (a) create a Clerk invitation with `notify: false`
 * so the pending account + metadata exists for downstream tooling, then
 * (b) send our own branded email through `sendEmail`. Either step can
 * fail without affecting the others — the caller is responsible for
 * persisting the pending membership rows; this function never rolls
 * them back on send failure.
 */
export async function deliverInviteEmails(args: {
  invites: Array<{ email: string; role: string }>;
  tenantId: number;
  tenantName: string;
  inviterFirstName: string | null;
  inviterLastName: string | null;
  inviterEmail: string;
  signUpBaseUrl: string | undefined;
}): Promise<{ results: InviteDeliveryResult[]; sent: number }> {
  const results: InviteDeliveryResult[] = [];
  let sent = 0;

  const inviterName =
    [args.inviterFirstName ?? "", args.inviterLastName ?? ""]
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" ") || null;

  for (const invite of args.invites) {
    const result: InviteDeliveryResult = {
      email: invite.email,
      role: invite.role,
      delivered: false,
    };

    // (a) Create Clerk invitation (metadata + pending account) — best effort
    try {
      const invitation = await clerkClient.invitations.createInvitation({
        emailAddress: invite.email,
        redirectUrl: args.signUpBaseUrl,
        publicMetadata: {
          pendingTenantId: args.tenantId,
          pendingRole: invite.role,
        },
        ignoreExisting: true,
        notify: false,
      });
      result.clerkInvitationId = invitation.id;
    } catch (err) {
      logger.warn(
        { err, tenantId: args.tenantId, inviteEmail: invite.email },
        "Clerk invitation create failed (continuing with branded email)",
      );
    }

    // (b) Send branded email — failure is logged but never rolls anything back
    if (!args.signUpBaseUrl) {
      result.reason =
        "Could not resolve a sign-up URL (set FRONTEND_URL so invite links work)";
      logger.warn(
        { tenantId: args.tenantId, inviteEmail: invite.email },
        "Skipping branded invite email — no sign-up URL resolved",
      );
      results.push(result);
      continue;
    }

    const signUpUrl = buildInviteSignUpUrl(args.signUpBaseUrl, invite.email);
    const content = buildInviteEmail({
      inviteeEmail: invite.email,
      inviterName,
      inviterEmail: args.inviterEmail,
      companyName: args.tenantName,
      role: invite.role,
      signUpUrl,
    });

    if (!isEmailConfigured()) {
      result.reason =
        "Email provider not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS";
      results.push(result);
      continue;
    }

    try {
      const ok = await sendEmail({ to: invite.email, ...content });
      result.delivered = ok;
      if (ok) {
        sent++;
      } else {
        result.reason = "Email provider rejected the message (see server logs)";
      }
    } catch (err) {
      result.reason = err instanceof Error ? err.message : "Unknown send error";
      logger.error(
        { err, tenantId: args.tenantId, inviteEmail: invite.email },
        "Branded invite email send failed",
      );
    }

    results.push(result);
  }

  return { results, sent };
}
