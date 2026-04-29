import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAdminKpi,
  useListAdminTenants,
  useCreateAdminTenant,
  useUpdateAdminTenant,
  useDeleteAdminTenant,
  useSyncTenantStripe,
  useGetTenantInvoices,
  getListAdminTenantsQueryKey,
  getGetAdminKpiQueryKey,
  getGetTenantInvoicesQueryKey,
} from "@workspace/api-client-react";
import type { AdminTenant } from "@workspace/api-client-react";
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

function KpiBar() {
  const { data: kpi, isLoading } = useGetAdminKpi();

  const cards = [
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
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {cards.map((c) => (
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

  const syncStripe = useSyncTenantStripe({
    mutation: {
      onSuccess: () => {
        toast({ title: "Stripe customer created" });
        void queryClient.invalidateQueries({
          queryKey: getListAdminTenantsQueryKey(),
        });
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

  const tenantId = tenant?.id ?? 0;
  const { data: invoiceData, isLoading: invoicesLoading } =
    useGetTenantInvoices(tenantId, {
      query: {
        queryKey: getGetTenantInvoicesQueryKey(tenantId),
        enabled: open && tenantId > 0,
      },
    });

  if (!tenant) return null;

  const rows: [string, string][] = [
    ["Slug", `/${tenant.slug}`],
    ["Status", tenant.status],
    ["Plan", tenant.planTier],
    ["Currency", tenant.currency ?? "—"],
    ["Email", tenant.email ?? "—"],
    ["Members", String(tenant.memberCount)],
    ["Stripe Customer", tenant.stripeCustomerId ?? "—"],
    ["Stripe Subscription", tenant.stripeSubscriptionId ?? "—"],
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

          {!tenant.stripeCustomerId && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => syncStripe.mutate({ id: tenant.id })}
              disabled={syncStripe.isPending}
            >
              <CreditCard className="mr-2 h-4 w-4" />
              {syncStripe.isPending ? "Creating..." : "Create Stripe Customer"}
            </Button>
          )}

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
      onSuccess: () => {
        toast({ title: "Tenant updated" });
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

  const nextPlan =
    tenant.planTier === "starter"
      ? "growth"
      : tenant.planTier === "growth"
        ? "enterprise"
        : "starter";

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
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
          <DropdownMenuItem
            onClick={() => setConfirm({ kind: "plan", plan: nextPlan as typeof nextPlan & ("starter" | "growth" | "enterprise") })}
          >
            <ArrowUpDown className="mr-2 h-4 w-4" />
            Switch to {nextPlan}
          </DropdownMenuItem>
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
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight">Super Admin</h2>
          <p className="text-sm text-muted-foreground">
            Platform management · all tenants
          </p>
        </div>
        <div className="flex items-center gap-2">
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
      </div>

      {/* KPIs */}
      <KpiBar />

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

      <CreateTenantDialog open={createOpen} onOpenChange={setCreateOpen} />
      <TenantDetailSheet
        tenant={detailTenant}
        open={!!detailTenant}
        onOpenChange={(v) => !v && setDetailTenant(null)}
      />
    </div>
  );
}
