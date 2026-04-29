import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateOnboardingTenant,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import type {
  OnboardingInvite,
  OnboardingInviteRole,
  OnboardingTenantInputPlanTier,
} from "@workspace/api-client-react";
import { useUser } from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  Command,
  Loader2,
  Mail,
  Plus,
  Sparkles,
  Trash2,
  Users,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types & constants ─────────────────────────────────────────────────────────

type Step = 0 | 1 | 2 | 3;

type PlanId = OnboardingTenantInputPlanTier;
type InviteRoleId = OnboardingInviteRole;

interface PlanOption {
  id: PlanId;
  name: string;
  priceLabel: string;
  description: string;
  highlights: string[];
  recommended?: boolean;
}

const PLAN_OPTIONS: PlanOption[] = [
  {
    id: "starter",
    name: "Starter",
    priceLabel: "Free",
    description: "Get up and running with the essentials.",
    highlights: ["Up to 5 users", "Procurement & Sales", "Email support"],
  },
  {
    id: "growth",
    name: "Growth",
    priceLabel: "$299/mo",
    description: "For teams ready to scale operations.",
    highlights: [
      "Up to 25 users",
      "Inventory + warehouse",
      "Stripe billing",
      "Priority support",
    ],
    recommended: true,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    priceLabel: "$999/mo",
    description: "Advanced controls, integrations, and SLA.",
    highlights: [
      "Unlimited users",
      "Audit logs & SSO",
      "Dedicated CSM",
      "99.9% uptime SLA",
    ],
  },
];

const ROLE_OPTIONS: Array<{ id: InviteRoleId; label: string }> = [
  { id: "tenant_admin", label: "Admin" },
  { id: "purchaser", label: "Purchaser" },
  { id: "warehouse", label: "Warehouse" },
  { id: "approver", label: "Approver" },
  { id: "accountant", label: "Accountant" },
  { id: "viewer", label: "Viewer" },
];

const STEPS = [
  { id: 0, name: "Company", icon: Building2 },
  { id: 1, name: "Plan", icon: Zap },
  { id: 2, name: "Invite team", icon: Users },
  { id: 3, name: "Review", icon: Check },
] as const;

interface InviteRow {
  id: string;
  email: string;
  role: InviteRoleId;
}

function newInviteRow(): InviteRow {
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`,
    email: "",
    role: "viewer",
  };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const { user } = useUser();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [step, setStep] = useState<Step>(0);
  const [companyName, setCompanyName] = useState("");
  const [industry, setIndustry] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [timezone, setTimezone] = useState(
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : "UTC",
  );
  const [planTier, setPlanTier] = useState<PlanId>("growth");
  const [invites, setInvites] = useState<InviteRow[]>([]);

  const createTenant = useCreateOnboardingTenant();

  const trimmedCompanyName = companyName.trim();
  const validInvites: OnboardingInvite[] = invites
    .map((row) => ({ email: row.email.trim().toLowerCase(), role: row.role }))
    .filter((row) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email));

  const canContinueFromCompany = trimmedCompanyName.length > 0;

  function goNext() {
    if (step === 0 && !canContinueFromCompany) {
      toast({
        title: "Company name required",
        description: "Tell us what to call your workspace.",
        variant: "destructive",
      });
      return;
    }
    setStep((s) => Math.min(3, s + 1) as Step);
  }
  function goBack() {
    setStep((s) => Math.max(0, s - 1) as Step);
  }

  function addInvite() {
    setInvites((prev) => [...prev, newInviteRow()]);
  }
  function updateInvite(id: string, patch: Partial<InviteRow>) {
    setInvites((prev) =>
      prev.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    );
  }
  function removeInvite(id: string) {
    setInvites((prev) => prev.filter((row) => row.id !== id));
  }

  async function handleSubmit() {
    try {
      const result = await createTenant.mutateAsync({
        data: {
          companyName: trimmedCompanyName,
          industryType: industry.trim() || undefined,
          currency,
          timezone,
          planTier,
          invites: validInvites.length > 0 ? validInvites : undefined,
        },
      });

      toast({
        title: result.alreadyOnboarded
          ? "Welcome back"
          : "Workspace ready",
        description: result.alreadyOnboarded
          ? `You already belong to ${result.name}. Taking you in.`
          : `${result.name} is set up${
              result.invitesSent > 0
                ? ` and ${result.invitesSent} invite${
                    result.invitesSent === 1 ? "" : "s"
                  } recorded.`
                : "."
            }`,
      });

      // Refresh /auth/me so ProtectedRoute lets the user into /dashboard
      await queryClient.invalidateQueries({
        queryKey: getGetCurrentUserQueryKey(),
      });
      setLocation("/dashboard");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong";
      toast({
        title: "Couldn't create workspace",
        description: message,
        variant: "destructive",
      });
    }
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-muted/30">
      {/* Header */}
      <header className="border-b border-border bg-white dark:bg-zinc-950">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex aspect-square size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Command className="size-5" />
            </div>
            <span className="text-base font-semibold tracking-tight">
              Forge ERP
            </span>
          </div>
          <p className="text-sm text-muted-foreground hidden sm:block">
            Signed in as{" "}
            <span className="font-medium text-foreground">
              {user?.primaryEmailAddress?.emailAddress ?? user?.firstName}
            </span>
          </p>
        </div>
      </header>

      {/* Stepper */}
      <div className="mx-auto w-full max-w-5xl px-6 pt-8">
        <ol className="flex items-center gap-2 sm:gap-4">
          {STEPS.map((s, idx) => {
            const Icon = s.icon;
            const isActive = step === s.id;
            const isComplete = step > s.id;
            return (
              <li
                key={s.id}
                className="flex items-center gap-2 sm:gap-4 flex-1"
                data-testid={`step-${s.id}`}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={cn(
                      "flex aspect-square size-8 items-center justify-center rounded-full border text-xs font-medium transition-colors",
                      isComplete &&
                        "bg-primary border-primary text-primary-foreground",
                      isActive &&
                        !isComplete &&
                        "bg-primary/10 border-primary text-primary",
                      !isActive &&
                        !isComplete &&
                        "bg-background border-border text-muted-foreground",
                    )}
                  >
                    {isComplete ? (
                      <Check className="size-4" />
                    ) : (
                      <Icon className="size-4" />
                    )}
                  </div>
                  <span
                    className={cn(
                      "text-sm font-medium hidden sm:inline",
                      (isActive || isComplete)
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {s.name}
                  </span>
                </div>
                {idx < STEPS.length - 1 && (
                  <div
                    className={cn(
                      "h-px flex-1 transition-colors",
                      step > s.id ? "bg-primary" : "bg-border",
                    )}
                  />
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {/* Card */}
      <main className="mx-auto w-full max-w-2xl px-6 py-8 flex-1">
        <div className="rounded-2xl border border-border bg-white dark:bg-zinc-950 shadow-sm p-6 sm:p-8 space-y-6">
          {step === 0 && (
            <div className="space-y-6" data-testid="panel-company">
              <div className="space-y-1">
                <h1 className="text-2xl font-bold tracking-tight">
                  Tell us about your company
                </h1>
                <p className="text-sm text-muted-foreground">
                  This becomes your workspace. You can change these later in
                  Settings.
                </p>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="company-name">
                    Company name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="company-name"
                    placeholder="Acme Manufacturing Co."
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    autoFocus
                    data-testid="input-company-name"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="industry">Industry (optional)</Label>
                  <Input
                    id="industry"
                    placeholder="Manufacturing, Retail, Distribution..."
                    value={industry}
                    onChange={(e) => setIndustry(e.target.value)}
                    data-testid="input-industry"
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="currency">Currency</Label>
                    <Select
                      value={currency}
                      onValueChange={(v) => setCurrency(v)}
                    >
                      <SelectTrigger
                        id="currency"
                        data-testid="select-currency"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="USD">USD — US Dollar</SelectItem>
                        <SelectItem value="EUR">EUR — Euro</SelectItem>
                        <SelectItem value="GBP">
                          GBP — British Pound
                        </SelectItem>
                        <SelectItem value="CAD">
                          CAD — Canadian Dollar
                        </SelectItem>
                        <SelectItem value="AUD">
                          AUD — Australian Dollar
                        </SelectItem>
                        <SelectItem value="JPY">
                          JPY — Japanese Yen
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="timezone">Timezone</Label>
                    <Input
                      id="timezone"
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                      data-testid="input-timezone"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-6" data-testid="panel-plan">
              <div className="space-y-1">
                <h1 className="text-2xl font-bold tracking-tight">
                  Choose a plan
                </h1>
                <p className="text-sm text-muted-foreground">
                  Start free; upgrade anytime. Your card isn't charged until
                  you confirm a paid plan.
                </p>
              </div>

              <div className="grid gap-3">
                {PLAN_OPTIONS.map((plan) => {
                  const selected = plan.id === planTier;
                  return (
                    <button
                      type="button"
                      key={plan.id}
                      onClick={() => setPlanTier(plan.id)}
                      className={cn(
                        "relative w-full text-left rounded-xl border p-4 transition-colors",
                        selected
                          ? "border-primary bg-primary/5 ring-2 ring-primary/20"
                          : "border-border hover:border-primary/50 hover:bg-muted/30",
                      )}
                      data-testid={`plan-${plan.id}`}
                    >
                      {plan.recommended && (
                        <span className="absolute -top-2 right-4 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
                          <Sparkles className="size-3" /> Recommended
                        </span>
                      )}
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-base font-semibold">
                              {plan.name}
                            </span>
                            {selected && (
                              <span className="inline-flex aspect-square size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                                <Check className="size-3" />
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {plan.description}
                          </p>
                        </div>
                        <div className="text-right">
                          <div className="text-base font-semibold">
                            {plan.priceLabel}
                          </div>
                        </div>
                      </div>
                      <ul className="mt-3 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                        {plan.highlights.map((h) => (
                          <li
                            key={h}
                            className="flex items-center gap-1.5"
                          >
                            <Check className="size-3 text-primary" />
                            {h}
                          </li>
                        ))}
                      </ul>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6" data-testid="panel-invites">
              <div className="space-y-1">
                <h1 className="text-2xl font-bold tracking-tight">
                  Invite your team
                </h1>
                <p className="text-sm text-muted-foreground">
                  Add teammates who should join {trimmedCompanyName || "your workspace"}.
                  You can also do this later from Settings.
                </p>
              </div>

              {invites.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center">
                  <Mail className="mx-auto mb-2 size-6 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    No invites yet — you can skip this step.
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {invites.map((row, idx) => {
                    const isInvalid =
                      row.email.length > 0 &&
                      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email.trim());
                    return (
                      <li
                        key={row.id}
                        className="flex items-start gap-2"
                        data-testid={`invite-row-${idx}`}
                      >
                        <div className="flex-1 space-y-1">
                          <Input
                            type="email"
                            placeholder="teammate@company.com"
                            value={row.email}
                            onChange={(e) =>
                              updateInvite(row.id, { email: e.target.value })
                            }
                            aria-invalid={isInvalid}
                            data-testid={`invite-email-${idx}`}
                          />
                          {isInvalid && (
                            <p className="text-xs text-destructive">
                              Enter a valid email
                            </p>
                          )}
                        </div>
                        <Select
                          value={row.role}
                          onValueChange={(v) =>
                            updateInvite(row.id, {
                              role: v as InviteRoleId,
                            })
                          }
                        >
                          <SelectTrigger
                            className="w-[150px]"
                            data-testid={`invite-role-${idx}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLE_OPTIONS.map((r) => (
                              <SelectItem key={r.id} value={r.id}>
                                {r.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => removeInvite(row.id)}
                          aria-label="Remove invite"
                          data-testid={`invite-remove-${idx}`}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}

              <Button
                type="button"
                variant="outline"
                onClick={addInvite}
                data-testid="button-add-invite"
              >
                <Plus className="mr-1 size-4" />
                Add teammate
              </Button>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6" data-testid="panel-review">
              <div className="space-y-1">
                <h1 className="text-2xl font-bold tracking-tight">
                  Review and create
                </h1>
                <p className="text-sm text-muted-foreground">
                  Make sure everything looks right.
                </p>
              </div>

              <dl className="rounded-lg border border-border divide-y divide-border text-sm">
                <ReviewRow label="Company" value={trimmedCompanyName || "—"} />
                {industry && (
                  <ReviewRow label="Industry" value={industry} />
                )}
                <ReviewRow
                  label="Plan"
                  value={
                    PLAN_OPTIONS.find((p) => p.id === planTier)?.name ?? planTier
                  }
                />
                <ReviewRow label="Currency" value={currency} />
                <ReviewRow label="Timezone" value={timezone} />
                <ReviewRow
                  label="Invites"
                  value={
                    validInvites.length === 0
                      ? "None"
                      : `${validInvites.length} teammate${validInvites.length === 1 ? "" : "s"}`
                  }
                />
              </dl>

              {validInvites.length > 0 && (
                <ul className="text-xs text-muted-foreground space-y-1">
                  {validInvites.map((inv) => (
                    <li key={inv.email} className="flex items-center gap-2">
                      <Mail className="size-3" />
                      <span className="font-mono">{inv.email}</span>
                      <span className="opacity-60">·</span>
                      <span>
                        {ROLE_OPTIONS.find((r) => r.id === inv.role)?.label}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <p className="text-xs text-muted-foreground">
                By creating this workspace you'll be set as the{" "}
                <strong>tenant admin</strong> with full access to all modules.
              </p>
            </div>
          )}

          {/* Nav buttons */}
          <div className="flex items-center justify-between border-t border-border pt-6">
            <Button
              type="button"
              variant="ghost"
              onClick={goBack}
              disabled={step === 0 || createTenant.isPending}
              data-testid="button-back"
            >
              <ChevronLeft className="mr-1 size-4" /> Back
            </Button>

            {step < 3 ? (
              <Button
                type="button"
                onClick={goNext}
                disabled={step === 0 && !canContinueFromCompany}
                data-testid="button-next"
              >
                Continue <ChevronRight className="ml-1 size-4" />
              </Button>
            ) : (
              <Button
                type="button"
                onClick={handleSubmit}
                disabled={createTenant.isPending || !canContinueFromCompany}
                data-testid="button-create-workspace"
              >
                {createTenant.isPending ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Creating…
                  </>
                ) : (
                  <>
                    Create workspace
                    <Check className="ml-1 size-4" />
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}
