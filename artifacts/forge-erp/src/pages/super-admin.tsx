import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
  useGetAdminKpi,
  useListAdminTenants,
  useGetAdminTenant,
  useGetAdminTrends,
  useGetAdminTenantActivity,
  getGetAdminTenantActivityQueryKey,
  useCreateAdminTenant,
  useUpdateAdminTenant,
  useDeleteAdminTenant,
  useSyncTenantStripe,
  useCreateTenantSubscription,
  useGetTenantInvoices,
  useListAdminTenantMembers,
  useUpdateAdminTenantMember,
  useGetAdminAuditLogs,
  useInviteAdminTenantMember,
  getListAdminTenantsQueryKey,
  getGetAdminKpiQueryKey,
  getGetTenantInvoicesQueryKey,
  getGetAdminTenantQueryKey,
  getListAdminTenantMembersQueryKey,
} from "@workspace/api-client-react";
import type {
  AdminTenant,
  AdminTenantMember,
  AdminTrends,
  AuditLog,
  TenantActivity,
  UpdateMemberBody,
  InviteMemberBody,
} from "@workspace/api-client-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import {
  MoreHorizontal,
  Plus,
  Building2,
  Users,
  CreditCard,
  TrendingUp,
  AlertCircle,
  Search,
  RefreshCw,
  ExternalLink,
  Shield,
  Ban,
  Trash2,
  ArrowUpDown,
  FileText,
  ChevronLeft,
  ChevronRight,
  Eye,
  UserPlus,
  Mail,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Status / Plan badges ──────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
    trial: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    suspended:
      "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    pending:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        styles[status] ?? "bg-muted text-muted-foreground",
      )}
    >
      {status}
    </span>
  );
}

function PlanBadge({ plan }: { plan: string }) {
  const styles: Record<string, string> = {
    starter:
      "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    growth:
      "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
    enterprise:
      "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold uppercase tracking-wide",
        styles[plan] ?? "bg-muted text-muted-foreground",
      )}
    >
      {plan}
    </span>
  );
}

// ── KPI bar ───────────────────────────────────────────────────────────────────

function formatMrr(cents: number): string {
  if (cents === 0) return "$0";
  const dollars = cents / 100;
  if (dollars >= 1000) return `$${(dollars / 1000).toFixed(1)}k`;
  return `$${dollars.toLocaleString()}`;
}

function KpiBar() {
  const { data: kpi, isLoading } = useGetAdminKpi();

  const countCards = [
    {
      label: "Total Tenants",
      value: kpi?.totalTenants ?? 0,
      Icon: Building2,
      color: "text-blue-600 dark:text-blue-400",
    },
    {
      label: "Active",
      value: kpi?.activeTenants ?? 0,
      Icon: TrendingUp,
      color: "text-emerald-600 dark:text-emerald-400",
    },
    {
      label: "Trial",
      value: kpi?.trialTenants ?? 0,
      Icon: AlertCircle,
      color: "text-amber-600 dark:text-amber-400",
    },
    {
      label: "Suspended",
      value: kpi?.suspendedTenants ?? 0,
      Icon: Ban,
      color: "text-red-600 dark:text-red-400",
    },
    {
      label: "Stripe Connected",
      value: kpi?.stripeConnectedTenants ?? 0,
      Icon: CreditCard,
      color: "text-violet-600 dark:text-violet-400",
    },
  ];

  return (
    <div className="space-y-3">
      {/* MRR highlight */}
      <Card className="border-violet-200 dark:border-violet-800 bg-gradient-to-r from-violet-50 to-white dark:from-violet-950/20 dark:to-background">
        <CardContent className="p-4 flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-muted-foreground flex items-center gap-1">
              <TrendingUp className="h-3.5 w-3.5 text-violet-500" />
              Estimated MRR
              {kpi?.mrrIsEstimate && (
                <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded ml-1">
                  plan-tier estimate
                </span>
              )}
            </p>
            {isLoading ? (
              <div className="h-8 w-24 rounded bg-muted animate-pulse mt-1" />
            ) : (
              <p className="text-3xl font-bold tabular-nums text-violet-700 dark:text-violet-400 mt-0.5">
                {formatMrr(kpi?.estimatedMrrCents ?? 0)}
                <span className="text-sm font-normal text-muted-foreground ml-1">/mo</span>
              </p>
            )}
          </div>
          <CreditCard className="h-8 w-8 text-violet-300 dark:text-violet-700" />
        </CardContent>
      </Card>

      {/* Count cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {countCards.map((c) => (
          <Card key={c.label}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {c.label}
                </p>
                <c.Icon className={cn("h-4 w-4", c.color)} />
              </div>
              {isLoading ? (
                <div className="h-7 w-12 rounded bg-muted animate-pulse" />
              ) : (
                <p className="text-2xl font-bold tabular-nums">{c.value}</p>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ── Trends section ────────────────────────────────────────────────────────────

function formatWeekLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function TrendsChart({
  title,
  description,
  data,
  variant,
  color,
  formatValue,
}: {
  title: string;
  description: string;
  data: AdminTrends["signupsPerWeek"];
  variant: "bar" | "line" | "area";
  color: string;
  formatValue?: (v: number) => string;
}) {
  const chartData = data.map((p) => ({
    label: formatWeekLabel(p.weekStart),
    value: p.value,
  }));

  const tooltipFormatter = (value: number | string): [string, string] => [
    formatValue ? formatValue(Number(value)) : String(value),
    title,
  ];

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent className="pb-3">
        <div className="h-40 w-full">
          <ResponsiveContainer width="100%" height="100%">
            {variant === "bar" ? (
              <BarChart
                data={chartData}
                margin={{ top: 4, right: 4, left: -12, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="currentColor"
                  className="text-border"
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  width={36}
                  tickFormatter={(v) => (formatValue ? formatValue(Number(v)) : String(v))}
                  allowDecimals={false}
                />
                <Tooltip
                  formatter={tooltipFormatter}
                  contentStyle={{ fontSize: 12, padding: "4px 8px" }}
                />
                <Bar dataKey="value" fill={color} radius={[3, 3, 0, 0]} />
              </BarChart>
            ) : variant === "area" ? (
              <AreaChart
                data={chartData}
                margin={{ top: 4, right: 4, left: -12, bottom: 0 }}
              >
                <defs>
                  <linearGradient id={`fill-${title}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="currentColor"
                  className="text-border"
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  tickFormatter={(v) => (formatValue ? formatValue(Number(v)) : String(v))}
                />
                <Tooltip
                  formatter={tooltipFormatter}
                  contentStyle={{ fontSize: 12, padding: "4px 8px" }}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={color}
                  strokeWidth={2}
                  fill={`url(#fill-${title})`}
                />
              </AreaChart>
            ) : (
              <LineChart
                data={chartData}
                margin={{ top: 4, right: 4, left: -12, bottom: 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="currentColor"
                  className="text-border"
                />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  width={36}
                  tickFormatter={(v) => (formatValue ? formatValue(Number(v)) : String(v))}
                  allowDecimals={false}
                />
                <Tooltip
                  formatter={tooltipFormatter}
                  contentStyle={{ fontSize: 12, padding: "4px 8px" }}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={color}
                  strokeWidth={2}
                  dot={false}
                />
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

const TREND_RANGES: Array<{ label: string; weeks: number }> = [
  { label: "8w", weeks: 8 },
  { label: "12w", weeks: 12 },
  { label: "26w", weeks: 26 },
  { label: "52w", weeks: 52 },
];

function TrendsSection() {
  const [weeks, setWeeks] = useState(12);
  const { data, isLoading } = useGetAdminTrends({ weeks });

  return (
    <div className="space-y-3" data-testid="admin-trends-section">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <TrendingUp className="h-4 w-4 text-violet-500" />
            Trends
          </h3>
          <p className="text-xs text-muted-foreground">
            Weekly platform health signals
            {data?.mrrIsEstimate && (
              <span className="ml-1.5 text-[10px] bg-muted px-1.5 py-0.5 rounded">
                MRR is plan-tier estimate
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {TREND_RANGES.map((r) => (
            <Button
              key={r.weeks}
              size="sm"
              variant={weeks === r.weeks ? "default" : "outline"}
              className="h-7 px-2.5 text-xs"
              onClick={() => setWeeks(r.weeks)}
              data-testid={`trend-range-${r.weeks}`}
            >
              {r.label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading || !data ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-4">
                <div className="h-4 w-32 rounded bg-muted animate-pulse mb-3" />
                <div className="h-40 w-full rounded bg-muted animate-pulse" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <TrendsChart
            title="Signups per week"
            description="New tenants created"
            data={data.signupsPerWeek}
            variant="bar"
            color="#3b82f6"
          />
          <TrendsChart
            title="Active tenants"
            description="Cumulative non-suspended tenants"
            data={data.activeTenantsOverTime}
            variant="line"
            color="#10b981"
          />
          <TrendsChart
            title="MRR over time"
            description={
              data.mrrIsEstimate
                ? "Estimated from current plan tiers"
                : "From Stripe active subscriptions"
            }
            data={data.mrrCentsOverTime}
            variant="area"
            color="#8b5cf6"
            formatValue={(v) => formatMrr(v)}
          />
        </div>
      )}
    </div>
  );
}

// ── Per-tenant activity sparkline ─────────────────────────────────────────────

function TenantActivitySparkline({
  tenantId,
  open,
}: {
  tenantId: number;
  open: boolean;
}) {
  const { data, isLoading } = useGetAdminTenantActivity(
    tenantId,
    { days: 30 },
    {
      query: {
        queryKey: getGetAdminTenantActivityQueryKey(tenantId, { days: 30 }),
        enabled: open && tenantId > 0,
      },
    },
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <TrendingUp className="h-4 w-4" />
          Activity
          {data && (
            <span className="text-xs font-normal text-muted-foreground">
              · {data.totalEvents} events / {data.days}d
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        {isLoading || !data ? (
          <div className="h-20 w-full rounded bg-muted animate-pulse" />
        ) : data.totalEvents === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            No audit-log activity in the last {data.days} days.
          </p>
        ) : (
          <div className="h-20 w-full" data-testid="tenant-activity-sparkline">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data.activity}
                margin={{ top: 2, right: 2, left: 2, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#6366f1" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="#6366f1" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <Tooltip
                  formatter={(v: number | string) => [String(v), "events"]}
                  labelFormatter={(label: string) =>
                    new Date(label).toLocaleDateString()
                  }
                  contentStyle={{ fontSize: 11, padding: "2px 6px" }}
                />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke="#6366f1"
                  strokeWidth={1.5}
                  fill="url(#spark-fill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Confirm dialog ────────────────────────────────────────────────────────────

function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  variant = "destructive",
  onConfirm,
  isPending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  variant?: "destructive" | "default";
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button variant={variant} onClick={onConfirm} disabled={isPending}>
            {isPending ? "Processing..." : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Tenant members card ───────────────────────────────────────────────────────

// Tenant-scoped roles selectable from the per-row dropdown.
// `super_admin` is intentionally excluded — it's a platform-wide role and is
// granted/revoked via the dedicated "Make/Revoke super admin" button below.
const ROLE_OPTIONS: Array<AdminTenantMember["role"]> = [
  "tenant_admin",
  "purchaser",
  "warehouse",
  "approver",
  "accountant",
  "viewer",
];

function RoleBadge({ role }: { role: string }) {
  const styles: Record<string, string> = {
    super_admin:
      "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-400",
    tenant_admin:
      "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-400",
    purchaser:
      "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    warehouse:
      "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
    approver:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400",
    accountant:
      "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-400",
    viewer: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
        styles[role] ?? "bg-muted text-muted-foreground",
      )}
    >
      {role.replace("_", " ")}
    </span>
  );
}

// ── Invite member dialog ──────────────────────────────────────────────────────

const INVITE_ROLE_OPTIONS: Array<InviteMemberBody["role"]> = [
  "tenant_admin",
  "purchaser",
  "warehouse",
  "approver",
  "accountant",
  "viewer",
];

function InviteMemberDialog({
  tenantId,
  tenantName,
  open,
  onOpenChange,
}: {
  tenantId: number;
  tenantName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InviteMemberBody["role"]>("viewer");

  function reset() {
    setEmail("");
    setRole("viewer");
  }

  const inviteMember = useInviteAdminTenantMember({
    mutation: {
      onSuccess: (data) => {
        if (data.invitationDelivered) {
          toast({
            title: "Invitation sent",
            description: `${data.membership.email} will appear as a member once they accept.`,
          });
        } else {
          toast({
            title: "Pending member added — email NOT sent",
            description:
              data.deliveryReason ??
              "Clerk did not deliver the invite. The user can still be bound by signing up with this email.",
            variant: "destructive",
          });
        }
        void queryClient.invalidateQueries({
          queryKey: getListAdminTenantMembersQueryKey(tenantId),
        });
        void queryClient.invalidateQueries({
          queryKey: getListAdminTenantsQueryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: getGetAdminTenantQueryKey(tenantId),
        });
        onOpenChange(false);
        reset();
      },
      onError: (err) => {
        const e = err as unknown as {
          response?: { data?: { error?: string; code?: string } };
          message?: string;
        };
        const msg =
          e.response?.data?.error ?? e.message ?? "Failed to send invitation";
        toast({
          title: "Invitation failed",
          description: msg,
          variant: "destructive",
        });
      },
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    inviteMember.mutate({
      id: tenantId,
      data: { email: email.trim().toLowerCase(), role },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Add member
          </DialogTitle>
          <DialogDescription>
            Invite someone to <span className="font-medium">{tenantName}</span>.
            They'll get an email from Clerk and become a member when they sign
            in.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Email *</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="person@example.com"
              required
              data-testid="invite-member-email-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Role *</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as InviteMemberBody["role"])}
            >
              <SelectTrigger data-testid="invite-member-role-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INVITE_ROLE_OPTIONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r.replace("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
              disabled={inviteMember.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={inviteMember.isPending || !email.trim()}
              data-testid="invite-member-submit"
            >
              {inviteMember.isPending ? (
                "Sending…"
              ) : (
                <>
                  <Mail className="mr-1.5 h-4 w-4" />
                  Send invitation
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function TenantMembersCard({
  tenantId,
  tenantName,
  open,
}: {
  tenantId: number;
  tenantName: string;
  open: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [selfRevokeMember, setSelfRevokeMember] =
    useState<AdminTenantMember | null>(null);

  const { data: currentUser } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });

  const { data: members, isLoading } = useListAdminTenantMembers(tenantId, {
    query: {
      queryKey: getListAdminTenantMembersQueryKey(tenantId),
      enabled: open && tenantId > 0,
    },
  });

  const updateMember = useUpdateAdminTenantMember({
    mutation: {
      onSuccess: (_data, variables) => {
        toast({ title: "Member updated" });
        void queryClient.invalidateQueries({
          queryKey: getListAdminTenantMembersQueryKey(tenantId),
        });
        void queryClient.invalidateQueries({
          queryKey: getListAdminTenantsQueryKey(),
        });
        // If the current user just demoted themselves out of super_admin,
        // the /super-admin page would 403 on the next refetch. Refresh
        // /auth/me and bounce to /dashboard so the route guard handles
        // the new role gracefully instead of showing an error.
        if (
          selfRevokeMember &&
          variables.membershipId === selfRevokeMember.id &&
          variables.data.role &&
          variables.data.role !== "super_admin"
        ) {
          setSelfRevokeMember(null);
          void queryClient.invalidateQueries({
            queryKey: getGetCurrentUserQueryKey(),
          });
          setLocation("/dashboard");
        }
      },
      onError: (error) => {
        const data = (error as { data?: { error?: string; code?: string } })
          ?.data;
        const status = (error as { status?: number })?.status;
        if (data?.code === "LAST_SUPER_ADMIN" || status === 409) {
          toast({
            title: "Action blocked",
            description:
              data?.error ??
              "At least one active super admin must remain on the platform.",
            variant: "destructive",
          });
          return;
        }
        toast({
          title: "Error",
          description: data?.error ?? "Failed to update member",
          variant: "destructive",
        });
      },
    },
  });

  function handleUpdate(membershipId: number, data: UpdateMemberBody) {
    updateMember.mutate({ id: tenantId, membershipId, data });
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Users className="h-4 w-4" />
            Members
            {members && (
              <span className="text-xs font-normal text-muted-foreground">
                ({members.length})
              </span>
            )}
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => setInviteOpen(true)}
            data-testid="add-member-button"
          >
            <UserPlus className="mr-1 h-3.5 w-3.5" />
            Add member
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : !members || members.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No members yet. Click "Add member" to invite someone, or wait for a
            user to complete onboarding.
          </p>
        ) : (
          <div className="space-y-2">
            {members.map((m) => {
              const isPending = m.clerkId.startsWith("pending:");
              return (
                <div
                  key={m.id}
                  className={cn(
                    "rounded-md border p-2.5 text-sm space-y-2",
                    !m.isActive && "opacity-60 bg-muted/40",
                  )}
                  data-testid={`member-row-${m.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate flex items-center gap-1.5">
                        {[m.firstName, m.lastName].filter(Boolean).join(" ") ||
                          m.email}
                        {isPending && (
                          <span className="text-[10px] uppercase tracking-wide font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400 px-1.5 py-0.5 rounded">
                            Invited
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {m.email}
                      </p>
                    </div>
                    <RoleBadge role={m.role} />
                  </div>
                  <div className="flex items-center gap-2 pt-1">
                    <Select
                      value={m.role}
                      onValueChange={(v) =>
                        handleUpdate(m.id, {
                          role: v as AdminTenantMember["role"],
                        })
                      }
                      disabled={updateMember.isPending}
                    >
                      <SelectTrigger
                        className="h-7 text-xs flex-1"
                        data-testid={`member-role-select-${m.id}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLE_OPTIONS.map((role) => (
                          <SelectItem key={role} value={role}>
                            {role.replace("_", " ")}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant={m.isActive ? "outline" : "default"}
                      size="sm"
                      className="h-7 text-xs whitespace-nowrap"
                      onClick={() =>
                        handleUpdate(m.id, { isActive: !m.isActive })
                      }
                      disabled={updateMember.isPending || isPending}
                      data-testid={`member-toggle-active-${m.id}`}
                      title={
                        isPending
                          ? "Pending invites cannot be activated until accepted"
                          : undefined
                      }
                    >
                      {m.isActive ? (
                        <>
                          <Ban className="mr-1 h-3 w-3" />
                          Deactivate
                        </>
                      ) : (
                        <>
                          <Shield className="mr-1 h-3 w-3" />
                          Reactivate
                        </>
                      )}
                    </Button>
                  </div>
                  {/* Dedicated platform-wide super_admin grant/revoke. */}
                  {!isPending && (
                    <div className="flex items-center gap-2 pt-1">
                      <Button
                        variant={
                          m.role === "super_admin" ? "destructive" : "secondary"
                        }
                        size="sm"
                        className="h-7 text-xs whitespace-nowrap"
                        onClick={() => {
                          const isSelf =
                            !!currentUser?.clerkId &&
                            currentUser.clerkId === m.clerkId;
                          // Self-revocation immediately costs us /super-admin
                          // access — confirm before proceeding so admins don't
                          // accidentally lock themselves out with one click.
                          if (isSelf && m.role === "super_admin") {
                            setSelfRevokeMember(m);
                            return;
                          }
                          handleUpdate(m.id, {
                            role:
                              m.role === "super_admin"
                                ? "tenant_admin"
                                : "super_admin",
                          });
                        }}
                        disabled={
                          updateMember.isPending ||
                          !m.isActive ||
                          // Wait for /auth/me before allowing a revoke so we
                          // can reliably detect self-demotion and show the
                          // confirmation dialog.
                          (m.role === "super_admin" && !currentUser)
                        }
                        data-testid={`member-toggle-super-admin-${m.id}`}
                        title={
                          !m.isActive
                            ? "Reactivate the member before changing super_admin status"
                            : m.role === "super_admin"
                              ? "Demote this user back to tenant_admin"
                              : "Grant platform-wide super_admin access"
                        }
                      >
                        <Shield className="mr-1 h-3 w-3" />
                        {m.role === "super_admin"
                          ? "Revoke super admin"
                          : "Make super admin"}
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
      <InviteMemberDialog
        tenantId={tenantId}
        tenantName={tenantName}
        open={inviteOpen}
        onOpenChange={setInviteOpen}
      />
      <ConfirmDialog
        open={!!selfRevokeMember}
        onOpenChange={(v) => {
          if (!v) setSelfRevokeMember(null);
        }}
        title="Revoke your own super admin access?"
        description="You are about to remove super admin from your own account. You will immediately lose access to /super-admin and be redirected to the dashboard. Another super admin will need to re-promote you to restore access."
        confirmLabel="Revoke my super admin"
        variant="destructive"
        onConfirm={() => {
          if (!selfRevokeMember) return;
          updateMember.mutate({
            id: tenantId,
            membershipId: selfRevokeMember.id,
            data: { role: "tenant_admin" },
          });
        }}
        isPending={updateMember.isPending}
      />
    </Card>
  );
}

// ── Tenant detail sheet ───────────────────────────────────────────────────────

function TenantDetailSheet({
  tenant,
  open,
  onOpenChange,
}: {
  tenant: AdminTenant | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const tenantId = tenant?.id ?? 0;

  // Fetch full tenant detail for live billing/subscription status from Stripe
  const { data: tenantDetail, refetch: refetchDetail } = useGetAdminTenant(tenantId, {
    query: {
      queryKey: getGetAdminTenantQueryKey(tenantId),
      enabled: open && tenantId > 0,
    },
  });

  function invalidateAll() {
    void queryClient.invalidateQueries({ queryKey: getListAdminTenantsQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetAdminKpiQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetAdminTenantQueryKey(tenantId) });
    void refetchDetail();
  }

  const syncStripe = useSyncTenantStripe({
    mutation: {
      onSuccess: () => {
        toast({ title: "Stripe customer created" });
        invalidateAll();
      },
      onError: () => {
        toast({
          title: "Error",
          description: "Stripe sync failed",
          variant: "destructive",
        });
      },
    },
  });

  const createSubscription = useCreateTenantSubscription({
    mutation: {
      onSuccess: (data) => {
        toast({
          title: data.created ? "Subscription created" : "Subscription updated",
          description: `Status: ${data.status}`,
        });
        invalidateAll();
      },
      onError: () => {
        toast({
          title: "Error",
          description: "Stripe subscription failed — check STRIPE_PRICE_* env vars are set",
          variant: "destructive",
        });
      },
    },
  });

  const { data: invoiceData, isLoading: invoicesLoading } =
    useGetTenantInvoices(tenantId, {
      query: {
        queryKey: getGetTenantInvoicesQueryKey(tenantId),
        enabled: open && tenantId > 0,
      },
    });

  if (!tenant) return null;

  // Use detail data for live billing fields; fall back to list data for basic fields
  const displayTenant = tenantDetail ?? tenant;

  const rows: [string, string][] = [
    ["Slug", `/${tenant.slug}`],
    ["Status", tenant.status],
    ["Plan", tenant.planTier],
    ["Currency", tenant.currency ?? "—"],
    ["Email", tenant.email ?? "—"],
    ["Members", String(tenant.memberCount)],
    ["Storage", `${tenant.storageUsageMb} MB`],
    ["Stripe Customer", tenant.stripeCustomerId ?? "—"],
    ["Stripe Subscription", displayTenant.stripeSubscriptionId ?? "—"],
    ["Billing Status", tenantDetail?.subscriptionStatus ?? "—"],
    ["Period Ends", tenantDetail?.currentPeriodEnd
      ? new Date(tenantDetail.currentPeriodEnd).toLocaleDateString()
      : "—"],
    ["Created", new Date(tenant.createdAt).toLocaleDateString()],
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            {tenant.name}
          </SheetTitle>
        </SheetHeader>

        <div className="mt-6 space-y-5">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Details</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <dl>
                {rows.map(([key, value]) => (
                  <div
                    key={key}
                    className="flex justify-between border-b px-4 py-2 last:border-0 text-sm"
                  >
                    <dt className="text-muted-foreground shrink-0 mr-4">
                      {key}
                    </dt>
                    <dd className="font-medium truncate text-right">{value}</dd>
                  </div>
                ))}
              </dl>
            </CardContent>
          </Card>

          <div className="flex gap-2">
            {!tenant.stripeCustomerId && (
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => syncStripe.mutate({ id: tenant.id })}
                disabled={syncStripe.isPending}
              >
                <CreditCard className="mr-2 h-4 w-4" />
                {syncStripe.isPending ? "Creating..." : "Create Stripe Customer"}
              </Button>
            )}
            {tenant.stripeCustomerId && (
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() =>
                  createSubscription.mutate({ id: tenant.id, data: { planTier: tenant.planTier } })
                }
                disabled={createSubscription.isPending}
              >
                <CreditCard className="mr-2 h-4 w-4" />
                {createSubscription.isPending
                  ? "Processing..."
                  : tenant.stripeSubscriptionId
                    ? "Sync Subscription"
                    : "Create Subscription"}
              </Button>
            )}
          </div>

          <TenantActivitySparkline tenantId={tenant.id} open={open} />

          <TenantMembersCard
            tenantId={tenant.id}
            tenantName={tenant.name}
            open={open}
          />

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">Invoices</CardTitle>
            </CardHeader>
            <CardContent>
              {invoicesLoading ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : !invoiceData?.stripeConfigured ? (
                <p className="text-xs text-muted-foreground">
                  Stripe not configured. Connect Stripe via the Integrations tab.
                </p>
              ) : invoiceData.invoices.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No invoices found.
                </p>
              ) : (
                <div className="space-y-2">
                  {invoiceData.invoices.map((inv) => (
                    <div
                      key={inv.id}
                      className="flex items-center justify-between rounded-md border p-2 text-sm"
                    >
                      <div>
                        <p className="font-medium">{inv.number ?? inv.id}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(inv.created).toLocaleDateString()} ·{" "}
                          {inv.status}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold tabular-nums">
                          {(inv.amountDue / 100).toFixed(2)}{" "}
                          {inv.currency.toUpperCase()}
                        </span>
                        {inv.hostedInvoiceUrl && (
                          <a
                            href={inv.hostedInvoiceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                          </a>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Create tenant dialog ──────────────────────────────────────────────────────

function CreateTenantDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [planTier, setPlanTier] = useState<"starter" | "growth" | "enterprise">(
    "starter",
  );
  const [status, setStatus] = useState<"active" | "trial" | "pending">("trial");

  function reset() {
    setName("");
    setEmail("");
    setPlanTier("starter");
    setStatus("trial");
  }

  const createTenant = useCreateAdminTenant({
    mutation: {
      onSuccess: () => {
        toast({ title: "Tenant created successfully" });
        void queryClient.invalidateQueries({
          queryKey: getListAdminTenantsQueryKey(),
        });
        void queryClient.invalidateQueries({
          queryKey: getGetAdminKpiQueryKey(),
        });
        onOpenChange(false);
        reset();
      },
      onError: () => {
        toast({
          title: "Error",
          description: "Failed to create tenant",
          variant: "destructive",
        });
      },
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    createTenant.mutate({
      data: {
        name,
        email: email || undefined,
        planTier,
        status,
        currency: "USD",
      },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Tenant</DialogTitle>
          <DialogDescription>
            Add a new company to the platform.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ct-name">Company Name *</Label>
            <Input
              id="ct-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ct-email">Billing Email</Label>
            <Input
              id="ct-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@acme.com"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Plan</Label>
              <Select
                value={planTier}
                onValueChange={(v) =>
                  setPlanTier(v as typeof planTier)
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="starter">Starter</SelectItem>
                  <SelectItem value="growth">Growth</SelectItem>
                  <SelectItem value="enterprise">Enterprise</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as typeof status)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="trial">Trial</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
              disabled={createTenant.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createTenant.isPending || !name.trim()}
            >
              {createTenant.isPending ? "Creating…" : "Create Tenant"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Row action menu ───────────────────────────────────────────────────────────

type ConfirmType =
  | { kind: "suspend" }
  | { kind: "unsuspend" }
  | { kind: "delete" }
  | { kind: "plan"; plan: "starter" | "growth" | "enterprise" };

function TenantRowActions({
  tenant,
  onViewDetail,
}: {
  tenant: AdminTenant;
  onViewDetail: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState<ConfirmType | null>(null);

  function invalidate() {
    void queryClient.invalidateQueries({
      queryKey: getListAdminTenantsQueryKey(),
    });
    void queryClient.invalidateQueries({ queryKey: getGetAdminKpiQueryKey() });
  }

  const updateTenant = useUpdateAdminTenant({
    mutation: {
      onSuccess: (data) => {
        const sync = (data as { billingSyncStatus?: string | null; billingSyncReason?: string | null });
        if (sync.billingSyncStatus === "failed") {
          toast({
            title: "Tenant updated — billing sync FAILED",
            description: `Plan changed in DB but Stripe was not: ${sync.billingSyncReason ?? "unknown error"}. Reconcile manually.`,
            variant: "destructive",
          });
        } else if (sync.billingSyncStatus === "skipped") {
          toast({
            title: "Tenant updated — billing sync skipped",
            description: sync.billingSyncReason ?? "No Stripe action taken.",
          });
        } else if (sync.billingSyncStatus === "ok") {
          toast({
            title: "Tenant updated",
            description: "Plan and Stripe subscription are in sync.",
          });
        } else {
          toast({ title: "Tenant updated" });
        }
        invalidate();
        setConfirm(null);
      },
      onError: () => {
        toast({
          title: "Error",
          description: "Update failed",
          variant: "destructive",
        });
      },
    },
  });

  const deleteTenant = useDeleteAdminTenant({
    mutation: {
      onSuccess: () => {
        toast({ title: "Tenant deleted" });
        invalidate();
        setConfirm(null);
      },
      onError: () => {
        toast({
          title: "Error",
          description: "Delete failed",
          variant: "destructive",
        });
      },
    },
  });

  const isSuspended = tenant.status === "suspended";

  const allPlans: Array<"starter" | "growth" | "enterprise"> = [
    "starter",
    "growth",
    "enterprise",
  ];

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onClick={onViewDetail}>
            <Building2 className="mr-2 h-4 w-4" />
            View details
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() =>
              setConfirm(isSuspended ? { kind: "unsuspend" } : { kind: "suspend" })
            }
          >
            {isSuspended ? (
              <>
                <Shield className="mr-2 h-4 w-4" />
                Unsuspend
              </>
            ) : (
              <>
                <Ban className="mr-2 h-4 w-4" />
                Suspend
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            Change plan
          </div>
          {allPlans.map((p) => (
            <DropdownMenuItem
              key={p}
              disabled={p === tenant.planTier}
              onClick={() => setConfirm({ kind: "plan", plan: p })}
            >
              <ArrowUpDown className="mr-2 h-4 w-4" />
              <span className="capitalize">{p}</span>
              {p === tenant.planTier && (
                <span className="ml-auto text-xs text-muted-foreground">current</span>
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setConfirm({ kind: "delete" })}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ConfirmDialog
        open={confirm?.kind === "suspend"}
        onOpenChange={(v) => !v && setConfirm(null)}
        title="Suspend tenant?"
        description={`This will suspend "${tenant.name}". Their users will lose access until unsuspended.`}
        confirmLabel="Suspend"
        onConfirm={() =>
          updateTenant.mutate({ id: tenant.id, data: { status: "suspended" } })
        }
        isPending={updateTenant.isPending}
      />

      <ConfirmDialog
        open={confirm?.kind === "unsuspend"}
        onOpenChange={(v) => !v && setConfirm(null)}
        title="Unsuspend tenant?"
        description={`Restore access for "${tenant.name}".`}
        confirmLabel="Unsuspend"
        variant="default"
        onConfirm={() =>
          updateTenant.mutate({ id: tenant.id, data: { status: "active" } })
        }
        isPending={updateTenant.isPending}
      />

      {confirm?.kind === "plan" && (
        <ConfirmDialog
          open
          onOpenChange={(v) => !v && setConfirm(null)}
          title="Change plan?"
          description={`Switch "${tenant.name}" from ${tenant.planTier} → ${confirm.plan}?`}
          confirmLabel={`Switch to ${confirm.plan}`}
          variant="default"
          onConfirm={() =>
            updateTenant.mutate({
              id: tenant.id,
              data: { planTier: confirm.plan },
            })
          }
          isPending={updateTenant.isPending}
        />
      )}

      <ConfirmDialog
        open={confirm?.kind === "delete"}
        onOpenChange={(v) => !v && setConfirm(null)}
        title="Delete tenant?"
        description={`Permanently delete "${tenant.name}" and suspend all access. This cannot be undone.`}
        confirmLabel="Delete permanently"
        onConfirm={() => deleteTenant.mutate({ id: tenant.id })}
        isPending={deleteTenant.isPending}
      />
    </>
  );
}

// ── Audit Logs tab ────────────────────────────────────────────────────────────

const AUDIT_PAGE_SIZE = 50;

function formatActorEmail(log: AuditLog): string {
  if (log.actorEmail) return log.actorEmail;
  if (log.actorClerkId) return log.actorClerkId;
  return "system";
}

function ActionBadge({ action }: { action: string }) {
  const lower = action.toLowerCase();
  let style = "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  if (lower.includes("created") || lower.includes("accepted")) {
    style =
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400";
  } else if (lower.includes("deleted") || lower.includes("failed")) {
    style = "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400";
  } else if (lower.includes("updated") || lower.includes("sync")) {
    style = "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400";
  } else if (
    lower.includes("stripe") ||
    lower.includes("subscription") ||
    lower.includes("billing")
  ) {
    style =
      "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-400";
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono font-medium",
        style,
      )}
    >
      {action}
    </span>
  );
}

function MetadataDiff({ log }: { log: AuditLog }) {
  const hasOld =
    log.oldValues !== null &&
    log.oldValues !== undefined &&
    !(typeof log.oldValues === "object" && Object.keys(log.oldValues as object).length === 0);
  const hasNew =
    log.newValues !== null &&
    log.newValues !== undefined &&
    !(typeof log.newValues === "object" && Object.keys(log.newValues as object).length === 0);

  if (!hasOld && !hasNew) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          data-testid={`audit-diff-trigger-${log.id}`}
        >
          <Eye className="mr-1 h-3 w-3" />
          View
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[420px] p-0"
        data-testid={`audit-diff-content-${log.id}`}
      >
        <div className="border-b px-3 py-2">
          <p className="text-xs font-semibold">Metadata diff</p>
          <p className="text-[10px] text-muted-foreground">
            {log.entityType ?? "—"}
            {log.entityId ? ` · #${log.entityId}` : ""}
          </p>
        </div>
        <div className="max-h-[360px] overflow-auto p-3 space-y-3">
          {hasOld && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400 mb-1">
                Before
              </p>
              <pre className="text-[11px] leading-snug bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
                {JSON.stringify(log.oldValues, null, 2)}
              </pre>
            </div>
          )}
          {hasNew && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400 mb-1">
                After
              </p>
              <pre className="text-[11px] leading-snug bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-900 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
                {JSON.stringify(log.newValues, null, 2)}
              </pre>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AuditLogsTab() {
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [page, setPage] = useState(0);

  const { data: tenants } = useListAdminTenants();

  // Fetch all audit logs (capped at 100 server-side) and apply both filters
  // client-side. We don't pass tenantId to the API because some tenant-scoped
  // events (e.g. "tenant.created") store the tenant in entityId rather than
  // tenant_id, so server-side filtering would hide them.
  const {
    data: logs,
    isLoading,
    isFetching,
    refetch,
  } = useGetAdminAuditLogs();

  const tenantNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const t of tenants ?? []) {
      map.set(t.id, t.name);
    }
    return map;
  }, [tenants]);

  const uniqueActions = useMemo(() => {
    const set = new Set<string>();
    for (const l of logs ?? []) set.add(l.action);
    return Array.from(set).sort();
  }, [logs]);

  const filtered = useMemo(() => {
    let result = logs ?? [];
    if (tenantFilter !== "all") {
      const tid = Number(tenantFilter);
      result = result.filter(
        (l) =>
          l.tenantId === tid ||
          (l.entityType === "tenant" && l.entityId === String(tid)),
      );
    }
    if (actionFilter !== "all") {
      result = result.filter((l) => l.action === actionFilter);
    }
    return result;
  }, [logs, tenantFilter, actionFilter]);

  // Reset to first page when filters change or result set shrinks
  useEffect(() => {
    setPage(0);
  }, [tenantFilter, actionFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / AUDIT_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages - 1);
  const pageItems = filtered.slice(
    currentPage * AUDIT_PAGE_SIZE,
    (currentPage + 1) * AUDIT_PAGE_SIZE,
  );

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={tenantFilter} onValueChange={setTenantFilter}>
          <SelectTrigger
            className="h-8 w-[200px] text-sm"
            data-testid="audit-filter-tenant"
          >
            <SelectValue placeholder="Tenant" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All tenants</SelectItem>
            {(tenants ?? []).map((t) => (
              <SelectItem key={t.id} value={String(t.id)}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={actionFilter} onValueChange={setActionFilter}>
          <SelectTrigger
            className="h-8 w-[220px] text-sm"
            data-testid="audit-filter-action"
          >
            <SelectValue placeholder="Action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {uniqueActions.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => void refetch()}
          disabled={isFetching}
          title="Refresh"
          data-testid="audit-refresh"
        >
          <RefreshCw
            className={cn("h-4 w-4", isFetching && "animate-spin")}
          />
        </Button>
        <div className="ml-auto text-xs text-muted-foreground">
          {filtered.length} {filtered.length === 1 ? "entry" : "entries"}
        </div>
      </div>

      {/* Table */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[160px]">Timestamp</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Target</TableHead>
              <TableHead className="w-[90px] text-right">Diff</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  {[140, 140, 180, 160, 60].map((w, j) => (
                    <TableCell key={j}>
                      <div
                        className="h-4 rounded bg-muted animate-pulse"
                        style={{ width: w }}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : pageItems.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="text-center py-16 text-muted-foreground"
                >
                  {(logs ?? []).length === 0
                    ? "No audit log entries yet."
                    : "No entries match your filters."}
                </TableCell>
              </TableRow>
            ) : (
              pageItems.map((log) => {
                // Resolve target tenant: prefer tenant_id, fall back to entityId
                // when the audit row is itself a tenant entity (e.g. tenant.created).
                let targetTenantId: number | null = log.tenantId ?? null;
                if (
                  targetTenantId == null &&
                  log.entityType === "tenant" &&
                  log.entityId
                ) {
                  const parsed = Number(log.entityId);
                  if (!Number.isNaN(parsed)) targetTenantId = parsed;
                }
                const tenantName =
                  targetTenantId != null
                    ? tenantNameById.get(targetTenantId) ??
                      `Tenant #${targetTenantId}`
                    : "—";
                return (
                  <TableRow
                    key={log.id}
                    data-testid={`audit-row-${log.id}`}
                  >
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap tabular-nums">
                      {new Date(log.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <ActionBadge action={log.action} />
                    </TableCell>
                    <TableCell className="text-sm truncate max-w-[220px]">
                      {formatActorEmail(log)}
                    </TableCell>
                    <TableCell className="text-sm">
                      <span className="font-medium">{tenantName}</span>
                      {log.entityType && (
                        <span className="text-xs text-muted-foreground ml-1">
                          · {log.entityType}
                          {log.entityId ? ` #${log.entityId}` : ""}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <MetadataDiff log={log} />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </Card>

      {/* Pagination */}
      {filtered.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Page {currentPage + 1} of {totalPages} · showing{" "}
            {pageItems.length} of {filtered.length}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={currentPage === 0}
              data-testid="audit-prev-page"
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={currentPage >= totalPages - 1}
              data-testid="audit-next-page"
            >
              Next
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SuperAdmin() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [planFilter, setPlanFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [detailTenant, setDetailTenant] = useState<AdminTenant | null>(null);

  const { data: tenants, isLoading, refetch } = useListAdminTenants();

  const filtered = (tenants ?? []).filter((t) => {
    const q = search.toLowerCase();
    const matchSearch =
      !q ||
      t.name.toLowerCase().includes(q) ||
      t.slug.toLowerCase().includes(q) ||
      (t.email ?? "").toLowerCase().includes(q);
    const matchStatus = statusFilter === "all" || t.status === statusFilter;
    const matchPlan = planFilter === "all" || t.planTier === planFilter;
    return matchSearch && matchStatus && matchPlan;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Super Admin</h2>
        <p className="text-sm text-muted-foreground">
          Platform management · all tenants
        </p>
      </div>

      {/* KPIs */}
      <KpiBar />

      {/* Trends */}
      <TrendsSection />

      <Tabs defaultValue="tenants" className="space-y-4">
        <TabsList>
          <TabsTrigger value="tenants" data-testid="tab-tenants">
            <Building2 className="mr-1.5 h-4 w-4" />
            Tenants
          </TabsTrigger>
          <TabsTrigger value="audit" data-testid="tab-audit">
            <FileText className="mr-1.5 h-4 w-4" />
            Audit Logs
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tenants" className="space-y-4">
          {/* Tenants toolbar */}
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              onClick={() => void refetch()}
              title="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              New Tenant
            </Button>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tenants…"
            className="pl-8 h-8 text-sm"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-[130px] text-sm">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="trial">Trial</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
          </SelectContent>
        </Select>
        <Select value={planFilter} onValueChange={setPlanFilter}>
          <SelectTrigger className="h-8 w-[130px] text-sm">
            <SelectValue placeholder="Plan" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All plans</SelectItem>
            <SelectItem value="starter">Starter</SelectItem>
            <SelectItem value="growth">Growth</SelectItem>
            <SelectItem value="enterprise">Enterprise</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Tenant table */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[220px]">Tenant</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead className="text-right">
                <Users className="inline h-4 w-4" />
              </TableHead>
              <TableHead>Stripe</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  {[220, 80, 90, 40, 160, 90, 40].map((w, j) => (
                    <TableCell key={j}>
                      <div
                        className="h-4 rounded bg-muted animate-pulse"
                        style={{ width: w }}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : filtered.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={7}
                  className="text-center py-16 text-muted-foreground"
                >
                  {(tenants ?? []).length === 0
                    ? "No tenants yet. Create one to get started."
                    : "No tenants match your filters."}
                </TableCell>
              </TableRow>
            ) : (
              filtered.map((tenant) => (
                <TableRow
                  key={tenant.id}
                  className="cursor-pointer"
                  onClick={() => setDetailTenant(tenant)}
                >
                  <TableCell>
                    <div>
                      <p className="font-medium text-sm leading-tight">
                        {tenant.name}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        /{tenant.slug}
                      </p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={tenant.status} />
                  </TableCell>
                  <TableCell>
                    <PlanBadge plan={tenant.planTier} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">
                    {tenant.memberCount}
                  </TableCell>
                  <TableCell>
                    {tenant.stripeCustomerId ? (
                      <Badge
                        variant="outline"
                        className="text-xs font-mono max-w-[140px] truncate"
                      >
                        {tenant.stripeCustomerId}
                      </Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {new Date(tenant.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <TenantRowActions
                      tenant={tenant}
                      onViewDetail={() => setDetailTenant(tenant)}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Card>
        </TabsContent>

        <TabsContent value="audit">
          <AuditLogsTab />
        </TabsContent>
      </Tabs>

      <CreateTenantDialog open={createOpen} onOpenChange={setCreateOpen} />
      <TenantDetailSheet
        tenant={detailTenant}
        open={!!detailTenant}
        onOpenChange={(v) => !v && setDetailTenant(null)}
      />
    </div>
  );
}
