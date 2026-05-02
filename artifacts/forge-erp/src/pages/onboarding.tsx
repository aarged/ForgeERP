import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useUser } from "@clerk/react";
import {
  useOnboardTenant,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Building2,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mail,
  Sparkles,
  CheckCircle2,
  CreditCard,
  Zap,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type StepNum = 1 | 2 | 3;
type PlanId = "starter" | "growth" | "enterprise";

interface WizardData {
  companyName: string;
  slug: string;
  planTier: PlanId;
  billingEmail: string;
}

const STEPS: Array<{ num: StepNum; title: string; description: string }> = [
  { num: 1, title: "Company", description: "Name your workspace" },
  { num: 2, title: "Plan", description: "Choose a subscription" },
  { num: 3, title: "Billing", description: "Where to send invoices" },
];

const PLANS: Array<{
  id: PlanId;
  name: string;
  price: string;
  cadence: string;
  blurb: string;
  highlights: string[];
  badge?: string;
}> = [
  {
    id: "starter",
    name: "Starter",
    price: "$0",
    cadence: "Free forever",
    blurb: "Perfect for trying Forge with a small team.",
    highlights: ["Up to 3 users", "1 warehouse", "Core ERP modules"],
  },
  {
    id: "growth",
    name: "Growth",
    price: "$199",
    cadence: "per month",
    blurb: "For growing teams that need full procurement & sales.",
    highlights: [
      "Up to 25 users",
      "Unlimited warehouses",
      "Approval workflows",
      "Email support",
    ],
    badge: "Most popular",
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "Let's talk",
    cadence: "custom contract",
    blurb: "Advanced controls, dedicated support, and custom SLAs.",
    highlights: [
      "Unlimited users",
      "Custom integrations",
      "SSO & audit exports",
      "Dedicated CSM",
    ],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function isValidEmail(value: string): boolean {
  // Lightweight client-side check; backend uses zod email validator.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

// ── Stepper ───────────────────────────────────────────────────────────────────

function StepperBar({ current }: { current: StepNum }) {
  return (
    <ol className="flex items-center justify-between gap-2 mb-8">
      {STEPS.map((s) => {
        const done = current > s.num;
        const active = current === s.num;
        return (
          <li
            key={s.num}
            className={cn(
              "flex-1 flex flex-col items-start gap-1 py-3 px-4 rounded-xl border transition-colors",
              active && "bg-orange-50 border-orange-200",
              done && "bg-emerald-50 border-emerald-200",
              !active && !done && "bg-white border-slate-200",
            )}
            data-testid={`stepper-step-${s.num}`}
            data-active={active ? "true" : "false"}
          >
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "w-6 h-6 rounded-full text-xs font-semibold flex items-center justify-center",
                  active && "bg-orange-500 text-white",
                  done && "bg-emerald-500 text-white",
                  !active && !done && "bg-slate-100 text-slate-500",
                )}
              >
                {done ? <Check className="w-3.5 h-3.5" /> : s.num}
              </span>
              <span
                className={cn(
                  "text-sm font-medium",
                  active && "text-orange-700",
                  done && "text-emerald-700",
                  !active && !done && "text-slate-500",
                )}
              >
                {s.title}
              </span>
            </div>
            <span className="text-xs text-slate-400 ml-8">{s.description}</span>
          </li>
        );
      })}
    </ol>
  );
}

// ── Steps ─────────────────────────────────────────────────────────────────────

function Step1Company({
  data,
  onChange,
}: {
  data: WizardData;
  onChange: (patch: Partial<WizardData>) => void;
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-orange-100 text-orange-600 flex items-center justify-center">
          <Building2 className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Tell us about your company
          </h2>
          <p className="text-sm text-slate-500">
            This becomes the name of your workspace.
          </p>
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="companyName">Company name</Label>
        <Input
          id="companyName"
          data-testid="input-company-name"
          placeholder="Acme, Inc."
          value={data.companyName}
          onChange={(e) => onChange({ companyName: e.target.value })}
          autoFocus
          maxLength={200}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="slug">Workspace URL</Label>
        <div className="flex items-center rounded-md border border-slate-200 bg-slate-50 overflow-hidden focus-within:border-orange-300 focus-within:ring-2 focus-within:ring-orange-100">
          <span className="px-3 text-xs text-slate-400 select-none">
            forge.app/
          </span>
          <Input
            id="slug"
            data-testid="input-slug"
            placeholder="acme"
            value={data.slug}
            onChange={(e) => onChange({ slug: slugify(e.target.value) })}
            className="border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 px-0"
            maxLength={60}
          />
        </div>
        <p className="text-xs text-slate-400">
          Lowercase letters, numbers, and hyphens. We&apos;ll suggest one if you
          leave it blank.
        </p>
      </div>
    </div>
  );
}

function Step2Plan({
  data,
  onChange,
}: {
  data: WizardData;
  onChange: (patch: Partial<WizardData>) => void;
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-orange-100 text-orange-600 flex items-center justify-center">
          <Sparkles className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Choose a plan</h2>
          <p className="text-sm text-slate-500">
            You can change this anytime from billing settings.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {PLANS.map((p) => {
          const selected = data.planTier === p.id;
          return (
            <button
              key={p.id}
              type="button"
              data-testid={`plan-${p.id}`}
              data-selected={selected ? "true" : "false"}
              onClick={() => onChange({ planTier: p.id })}
              className={cn(
                "text-left p-4 rounded-xl border transition-all",
                selected
                  ? "border-orange-400 ring-2 ring-orange-200 bg-orange-50/40"
                  : "border-slate-200 hover:border-slate-300 bg-white",
              )}
            >
              <div className="flex items-start justify-between gap-2 mb-2">
                <div>
                  <div className="text-sm font-semibold text-slate-900">
                    {p.name}
                  </div>
                  <div className="text-xs text-slate-500">{p.cadence}</div>
                </div>
                {p.badge && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-orange-500 text-white font-semibold">
                    {p.badge}
                  </span>
                )}
              </div>
              <div className="text-2xl font-bold text-slate-900 mb-1">
                {p.price}
              </div>
              <p className="text-xs text-slate-500 mb-3">{p.blurb}</p>
              <ul className="space-y-1.5">
                {p.highlights.map((h) => (
                  <li
                    key={h}
                    className="flex items-start gap-1.5 text-xs text-slate-600"
                  >
                    <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
                    <span>{h}</span>
                  </li>
                ))}
              </ul>
            </button>
          );
        })}
      </div>

      {data.planTier !== "starter" && (
        <div
          className="flex items-start gap-2 p-3 rounded-lg bg-blue-50 border border-blue-100 text-blue-800 text-sm"
          data-testid="paid-plan-notice"
        >
          <CreditCard className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            You&apos;ll be redirected to Stripe Checkout to enter payment details
            after the next step.
          </span>
        </div>
      )}
    </div>
  );
}

function Step3Billing({
  data,
  onChange,
}: {
  data: WizardData;
  onChange: (patch: Partial<WizardData>) => void;
}) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-orange-100 text-orange-600 flex items-center justify-center">
          <Mail className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Billing email</h2>
          <p className="text-sm text-slate-500">
            We&apos;ll send invoices and billing notifications here.
          </p>
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="billingEmail">Email address</Label>
        <Input
          id="billingEmail"
          type="email"
          data-testid="input-billing-email"
          placeholder="billing@yourcompany.com"
          value={data.billingEmail}
          onChange={(e) => onChange({ billingEmail: e.target.value })}
          autoFocus
        />
        {data.billingEmail && !isValidEmail(data.billingEmail) && (
          <p className="text-xs text-red-500">
            Please enter a valid email address.
          </p>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 p-4 bg-slate-50/40">
        <div className="text-xs text-slate-500 uppercase tracking-wide mb-2">
          Review
        </div>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-slate-500">Company</dt>
          <dd
            className="text-slate-900 font-medium"
            data-testid="review-company"
          >
            {data.companyName || "—"}
          </dd>
          <dt className="text-slate-500">Workspace URL</dt>
          <dd
            className="text-slate-900 font-mono text-xs"
            data-testid="review-slug"
          >
            forge.app/{data.slug || slugify(data.companyName) || "your-company"}
          </dd>
          <dt className="text-slate-500">Plan</dt>
          <dd
            className="text-slate-900 font-medium capitalize"
            data-testid="review-plan"
          >
            {data.planTier}
          </dd>
        </dl>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { user } = useUser();
  const [step, setStep] = useState<StepNum>(1);
  const [done, setDone] = useState(false);

  const userPrimaryEmail =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses?.[0]?.emailAddress ??
    "";

  const [data, setData] = useState<WizardData>({
    companyName: "",
    slug: "",
    planTier: "starter",
    billingEmail: "",
  });

  // Prefill billing email from Clerk once the user is loaded.
  useEffect(() => {
    if (userPrimaryEmail && !data.billingEmail) {
      setData((d) => ({ ...d, billingEmail: userPrimaryEmail }));
    }
  }, [userPrimaryEmail, data.billingEmail]);

  const onboardMutation = useOnboardTenant();

  const onChange = (patch: Partial<WizardData>) =>
    setData((d) => ({ ...d, ...patch }));

  // Per-step validation gating the Next/Submit button.
  const canAdvance = useMemo(() => {
    if (step === 1) return data.companyName.trim().length >= 1;
    if (step === 2) return Boolean(data.planTier);
    if (step === 3) return isValidEmail(data.billingEmail);
    return false;
  }, [step, data]);

  function goBack() {
    if (step === 1) return;
    setStep((s) => (s - 1) as StepNum);
  }

  async function handleSubmit() {
    try {
      const payload = {
        companyName: data.companyName.trim(),
        slug: data.slug ? data.slug : undefined,
        planTier: data.planTier,
        billingEmail: data.billingEmail.trim(),
      };
      const result = await onboardMutation.mutateAsync({ data: payload });

      // Refresh /auth/me so the protected routes see the new tenant.
      await queryClient.invalidateQueries({
        queryKey: getGetCurrentUserQueryKey(),
      });

      // The server tells us where to send the user via `redirectTo`. For paid
      // plans this is an absolute Stripe Checkout URL; for the starter plan
      // it's the relative path "/dashboard". Honour it directly so the
      // policy lives on the server.
      const target = result.redirectTo ?? "/dashboard";
      const isAbsolute = /^https?:\/\//i.test(target);

      if (isAbsolute) {
        toast({
          title: "Workspace created",
          description: "Redirecting to secure payment…",
        });
        window.location.href = target;
        return;
      }

      // Internal route: show a brief success state then navigate.
      setDone(true);
      setTimeout(() => setLocation(target), 900);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Something went wrong.";

      // Surface a clear, actionable retry hint when the server returns a
      // Stripe / billing error — the user did NOT get a workspace and can
      // retry (e.g. with the Starter plan) from this same form.
      const isPaidPlan = data.planTier !== "starter";
      const looksLikeBilling =
        /STRIPE|CHECKOUT|billing/i.test(msg) ||
        msg.toLowerCase().includes("payment");

      const description =
        isPaidPlan && looksLikeBilling
          ? `${msg} You can try again, pick a different plan, or choose the Starter plan to skip checkout.`
          : msg;

      toast({
        title: "Could not create your workspace",
        description,
        variant: "destructive",
      });
    }
  }

  function goNext() {
    if (!canAdvance) return;
    if (step < 3) {
      setStep((s) => (s + 1) as StepNum);
      return;
    }
    void handleSubmit();
  }

  if (done) {
    return (
      <div
        className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-orange-50 px-4"
        data-testid="onboarding-success"
      >
        <div className="w-full max-w-md bg-white rounded-2xl border border-slate-100 shadow-sm p-8 text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mb-4">
            <CheckCircle2 className="w-7 h-7" />
          </div>
          <h1 className="text-xl font-semibold text-slate-900 mb-2">
            Workspace ready
          </h1>
          <p className="text-sm text-slate-500 mb-4">
            Welcome to Forge. Taking you to your dashboard…
          </p>
          <Loader2 className="w-5 h-5 animate-spin text-orange-500 mx-auto" />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-orange-50 flex flex-col">
      <header className="flex items-center gap-3 px-6 py-4 bg-white/80 backdrop-blur border-b border-slate-100">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center">
          <span className="text-white font-bold text-sm">F</span>
        </div>
        <span className="font-bold text-slate-800 text-lg">Forge ERP</span>
        <span className="text-slate-300 mx-1">·</span>
        <span className="text-sm text-slate-500">Workspace Setup</span>
        {userPrimaryEmail && (
          <span className="ml-auto text-xs text-slate-400">
            {userPrimaryEmail}
          </span>
        )}
      </header>

      <main className="flex-1 flex items-start justify-center py-10 px-4">
        <div className="w-full max-w-2xl" data-testid="onboarding-wizard">
          <StepperBar current={step} />

          <div
            className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8 min-h-[360px]"
            data-testid={`step-${step}`}
          >
            {step === 1 && <Step1Company data={data} onChange={onChange} />}
            {step === 2 && <Step2Plan data={data} onChange={onChange} />}
            {step === 3 && <Step3Billing data={data} onChange={onChange} />}
          </div>

          <div className="flex items-center justify-between mt-6">
            <Button
              variant="ghost"
              onClick={goBack}
              disabled={step === 1 || onboardMutation.isPending}
              className="gap-2 text-slate-600"
              data-testid="button-back"
            >
              <ChevronLeft className="w-4 h-4" /> Back
            </Button>

            <span className="text-xs text-slate-400">
              Step {step} of {STEPS.length}
            </span>

            <Button
              onClick={goNext}
              disabled={!canAdvance || onboardMutation.isPending}
              className="gap-2 bg-orange-500 hover:bg-orange-600 text-white"
              data-testid="button-next"
            >
              {onboardMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" /> Setting up…
                </>
              ) : step === 3 ? (
                <>
                  <Zap className="w-4 h-4" /> Create workspace
                </>
              ) : (
                <>
                  Next <ChevronRight className="w-4 h-4" />
                </>
              )}
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
