import type { Request } from "express";
import { createClerkClient } from "@clerk/express";

export const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

export function pendingClerkIdForEmail(email: string): string {
  return `pending:${email.toLowerCase()}`;
}

export function isPendingClerkId(clerkId: string): boolean {
  return clerkId.startsWith("pending:");
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
  if (process.env.REPLIT_DEV_DOMAIN)
    add(`https://${process.env.REPLIT_DEV_DOMAIN}`);
  return [...out];
}

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
