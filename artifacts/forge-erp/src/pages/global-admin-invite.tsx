import { useEffect, useState } from "react";
import { useRoute, useLocation, Redirect } from "wouter";
import { Show, useAuth } from "@clerk/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetGlobalAdminInvitePreview,
  useRedeemGlobalAdminInvite,
  useGetCurrentUser,
  getGetGlobalAdminInvitePreviewQueryKey,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Shield, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";

const PENDING_TOKEN_KEY = "forge.pendingGlobalAdminInviteToken";

export function rememberPendingInviteToken(token: string) {
  try {
    sessionStorage.setItem(PENDING_TOKEN_KEY, token);
  } catch {
    /* ignore — best-effort */
  }
}

export function consumePendingInviteToken(): string | null {
  try {
    const v = sessionStorage.getItem(PENDING_TOKEN_KEY);
    if (v) sessionStorage.removeItem(PENDING_TOKEN_KEY);
    return v;
  } catch {
    return null;
  }
}

export function peekPendingInviteToken(): string | null {
  try {
    return sessionStorage.getItem(PENDING_TOKEN_KEY);
  } catch {
    return null;
  }
}

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function GlobalAdminInvitePage() {
  const [, params] = useRoute("/global-admin-invite/:token");
  const token = params?.token ?? "";
  const [, setLocation] = useLocation();
  const { isLoaded: clerkLoaded, isSignedIn } = useAuth();
  const queryClient = useQueryClient();

  const {
    data: preview,
    isLoading: previewLoading,
    error: previewError,
  } = useGetGlobalAdminInvitePreview(token, {
    query: {
      queryKey: getGetGlobalAdminInvitePreviewQueryKey(token),
      enabled: !!token,
      retry: false,
    },
  });

  const { data: currentUser, isLoading: userLoading } = useGetCurrentUser({
    query: {
      queryKey: getGetCurrentUserQueryKey(),
      enabled: !!isSignedIn,
    },
  });

  const [redeemState, setRedeemState] = useState<
    "idle" | "redeeming" | "ok" | "error"
  >("idle");
  const [redeemError, setRedeemError] = useState<string | null>(null);

  const redeem = useRedeemGlobalAdminInvite({
    mutation: {
      onSuccess: () => {
        setRedeemState("ok");
        void queryClient.invalidateQueries({
          queryKey: getGetCurrentUserQueryKey(),
        });
        // Brief delay so the success card flashes before redirect.
        window.setTimeout(() => setLocation("/global-admin"), 1200);
      },
      onError: (error) => {
        const data = (error as { data?: { error?: string; code?: string } })
          ?.data;
        setRedeemError(data?.error ?? "Failed to redeem invite.");
        setRedeemState("error");
      },
    },
  });

  // Auto-redeem once the user is signed in AND has a tenant membership.
  useEffect(() => {
    if (!token) return;
    if (!clerkLoaded || !isSignedIn) return;
    if (userLoading) return;
    if (!currentUser?.role) return; // wait for onboarding
    if (preview && preview.status !== "active") return;
    if (redeemState !== "idle") return;
    setRedeemState("redeeming");
    redeem.mutate({ data: { token } });
  }, [
    token,
    clerkLoaded,
    isSignedIn,
    userLoading,
    currentUser?.role,
    preview,
    redeemState,
    redeem,
  ]);

  // Persist token across sign-in/sign-up flows.
  useEffect(() => {
    if (token) rememberPendingInviteToken(token);
  }, [token]);

  if (!token) {
    return <Redirect to="/" />;
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-muted/30 px-4 py-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            Global-admin invite
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {previewLoading ? (
            <p className="text-sm text-muted-foreground">
              Validating invite link…
            </p>
          ) : previewError || !preview ? (
            <InviteError message="This invite link is invalid or no longer exists." />
          ) : preview.status === "used" ? (
            <InviteError message="This invite has already been redeemed." />
          ) : preview.status === "revoked" ? (
            <InviteError message="This invite has been revoked." />
          ) : preview.status === "expired" ? (
            <InviteError message="This invite has expired. Ask a global-admin to issue a new one." />
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                You've been invited to become a platform global-admin
                {preview.createdByEmail ? (
                  <>
                    {" "}
                    by{" "}
                    <span className="font-medium text-foreground">
                      {preview.createdByEmail}
                    </span>
                  </>
                ) : null}
                .
              </p>
              {preview.email && (
                <p className="text-xs text-muted-foreground">
                  This link is bound to{" "}
                  <span className="font-mono font-medium text-foreground">
                    {preview.email}
                  </span>{" "}
                  — you must sign in with that email.
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                Expires {new Date(preview.expiresAt).toLocaleString()}
              </p>

              <Show when="signed-out">
                <div className="space-y-2 pt-2">
                  <p className="text-sm">
                    Sign in or create an account to claim it.
                  </p>
                  <div className="flex gap-2">
                    <Button
                      className="flex-1"
                      onClick={() => {
                        const params = new URLSearchParams();
                        if (preview.email)
                          params.set("email_address", preview.email);
                        const qs = params.toString();
                        setLocation(
                          `/sign-up${qs ? `?${qs}` : ""}`,
                        );
                      }}
                      data-testid="invite-signup-button"
                    >
                      Create account
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1"
                      onClick={() => setLocation("/sign-in")}
                      data-testid="invite-signin-button"
                    >
                      Sign in
                    </Button>
                  </div>
                </div>
              </Show>

              <Show when="signed-in">
                {userLoading ? (
                  <RedeemStatus
                    icon="spinner"
                    message="Checking your account…"
                  />
                ) : !currentUser?.role ? (
                  <div className="space-y-3 pt-2">
                    <RedeemStatus
                      icon="info"
                      message="Finish onboarding first — your invite will activate as soon as your workspace is ready."
                    />
                    <Button
                      className="w-full"
                      onClick={() => setLocation("/onboarding")}
                      data-testid="invite-onboarding-button"
                    >
                      Go to onboarding
                    </Button>
                  </div>
                ) : redeemState === "ok" ? (
                  <RedeemStatus
                    icon="check"
                    message="You're now a global-admin. Redirecting…"
                  />
                ) : redeemState === "error" ? (
                  <div className="space-y-3 pt-2">
                    <RedeemStatus
                      icon="error"
                      message={
                        redeemError ?? "Failed to redeem invite."
                      }
                    />
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={() => {
                        setRedeemError(null);
                        setRedeemState("idle");
                      }}
                    >
                      Try again
                    </Button>
                  </div>
                ) : (
                  <RedeemStatus
                    icon="spinner"
                    message="Activating global-admin access…"
                  />
                )}
              </Show>
            </>
          )}
          <p className="text-[11px] text-muted-foreground/70 pt-2 border-t">
            Path:{" "}
            <code className="font-mono">{basePath}/global-admin-invite/…</code>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function InviteError({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
      <AlertCircle className="h-4 w-4 mt-0.5 text-destructive flex-shrink-0" />
      <p className="text-destructive-foreground">{message}</p>
    </div>
  );
}

function RedeemStatus({
  icon,
  message,
}: {
  icon: "spinner" | "check" | "error" | "info";
  message: string;
}) {
  const Icon =
    icon === "spinner"
      ? Loader2
      : icon === "check"
        ? CheckCircle2
        : icon === "error"
          ? AlertCircle
          : Shield;
  const tone =
    icon === "check"
      ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30 text-emerald-900 dark:text-emerald-200"
      : icon === "error"
        ? "border-destructive/40 bg-destructive/10 text-destructive-foreground"
        : "border-border bg-muted/40 text-foreground";
  return (
    <div
      className={`flex items-start gap-2 rounded-md border p-3 text-sm ${tone}`}
      data-testid={`invite-status-${icon}`}
    >
      <Icon
        className={`h-4 w-4 mt-0.5 flex-shrink-0 ${
          icon === "spinner" ? "animate-spin" : ""
        }`}
      />
      <p>{message}</p>
    </div>
  );
}
