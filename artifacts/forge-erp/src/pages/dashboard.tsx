import { useState, useMemo } from "react";
import { 
  useGetCurrentUser, 
  getGetCurrentUserQueryKey,
  useGetDashboardKpi,
  getGetDashboardKpiQueryKey,
  useGetDashboardWidgetType,
  getGetDashboardWidgetTypeQueryKey,
  type GetDashboardKpiRole
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  Calculator, PackageSearch, ShoppingCart, 
  AlertTriangle, CheckCircle2, DollarSign, Activity,
  TrendingUp, Clock, Package, FileText, FileBarChart,
  Settings2, ChevronUp, ChevronDown, ArrowUpDown
} from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { LucideIcon } from "lucide-react";

// ── Formatters ─────────────────────────────────────────────────────────────────

function fmt(n: number | string | null | undefined, isCurrency = false): string {
  if (n == null) return "—";
  const num = Number(n);
  if (isCurrency) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(num);
  }
  return new Intl.NumberFormat("en-US").format(num);
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString();
}

// ── KPI Interfaces ─────────────────────────────────────────────────────────────

interface PurchaserKpis {
  openPOs: number;
  awaitingApproval: number;
  itemsToReceive: number;
  supplierSpendMtd: number;
}
interface WarehouseKpis {
  pickSlipsReady: number;
  itemsToReceiveToday: number;
  lowStockAlerts: number;
  pendingCycleCounts: number;
}
interface ApproverKpis {
  pendingApprovals: number;
  approvedMtd: number;
  avgTurnaroundHours: number;
  valuePending: number;
  recentDecisions: RecentDecision[];
}
interface AccountantKpis {
  glPostingsToday: number;
  unreconciledDraftPostings: number;
  outstandingReceivables: number;
  trialBalanceTotalDebit: number;
  cashFlowEstimateMtd: number;
  cashInflowMtd: number;
  cashOutflowMtd: number;
}
interface AdminKpisExtra {
  openPOs: number;
  salesMtdValue: number;
  lowStockAlerts: number;
  glPostingsThisWeek: number;
  catalogItemCount: number;
  activeSalesOrders: number;
}
interface RecentDecision { code: string; type: string; amount: number; decision: string; decidedAt: string; }
type AnyKpis = Partial<AdminKpisExtra & PurchaserKpis & WarehouseKpis & ApproverKpis & AccountantKpis>;

// ── Widget data shapes ─────────────────────────────────────────────────────────

interface PoItem { id: number; code: string; supplierName: string; total: string | number; status: string; }
interface SoItem { id: number; code: string; customerName: string; total: string | number; status: string; }
interface StockAlertItem { itemCode: string; itemName: string; qtyOnHand: number; reorderPoint: number; }
interface PendingApprovalItem { type: string; code: string; requestedBy: string; amount: number; }
interface GlActivityItem { code: string; postedAt: string; notes: string; totalDebit: number; }

// ── Widget Components ──────────────────────────────────────────────────────────

function WidgetRecentPOs() {
  const { data, isLoading } = useGetDashboardWidgetType("recent-pos", undefined, { query: { queryKey: getGetDashboardWidgetTypeQueryKey("recent-pos") } });
  const items = (data?.data as unknown as PoItem[] | undefined) ?? [];
  if (isLoading) return <Skeleton className="h-64" />;
  return (
    <Card className="col-span-1">
      <CardHeader>
        <CardTitle className="text-lg">Recent Purchase Orders</CardTitle>
        <CardDescription>Latest procurement activity</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {items.slice(0, 5).map((po) => (
            <div key={po.id} className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium leading-none">{po.code}</p>
                <p className="text-xs text-muted-foreground">{po.supplierName}</p>
              </div>
              <div className="text-right space-y-1">
                <p className="text-sm font-medium">{fmt(po.total, true)}</p>
                <Badge variant="outline" className="text-[10px] uppercase">{po.status}</Badge>
              </div>
            </div>
          ))}
          {!items.length && <p className="text-sm text-muted-foreground text-center py-4">No recent POs</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function WidgetRecentOrders() {
  const { data, isLoading } = useGetDashboardWidgetType("recent-orders", undefined, { query: { queryKey: getGetDashboardWidgetTypeQueryKey("recent-orders") } });
  const items = (data?.data as unknown as SoItem[] | undefined) ?? [];
  if (isLoading) return <Skeleton className="h-64" />;
  return (
    <Card className="col-span-1">
      <CardHeader>
        <CardTitle className="text-lg">Recent Sales</CardTitle>
        <CardDescription>Latest customer orders</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {items.slice(0, 5).map((so) => (
            <div key={so.id} className="flex items-center justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium leading-none">{so.code}</p>
                <p className="text-xs text-muted-foreground">{so.customerName}</p>
              </div>
              <div className="text-right space-y-1">
                <p className="text-sm font-medium">{fmt(so.total, true)}</p>
                <Badge variant="outline" className="text-[10px] uppercase">{so.status}</Badge>
              </div>
            </div>
          ))}
          {!items.length && <p className="text-sm text-muted-foreground text-center py-4">No recent orders</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function WidgetStockAlerts() {
  const { data, isLoading } = useGetDashboardWidgetType("stock-alerts", undefined, { query: { queryKey: getGetDashboardWidgetTypeQueryKey("stock-alerts") } });
  const items = (data?.data as unknown as StockAlertItem[] | undefined) ?? [];
  if (isLoading) return <Skeleton className="h-64" />;
  return (
    <Card className="col-span-1">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-orange-500" />
          Stock Alerts
        </CardTitle>
        <CardDescription>Items below reorder point</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {items.slice(0, 5).map((item, i) => (
            <div key={i} className="flex items-center justify-between border-b last:border-0 pb-2 last:pb-0">
              <div className="space-y-1">
                <p className="text-sm font-medium leading-none">{item.itemCode}</p>
                <p className="text-xs text-muted-foreground truncate max-w-[150px]">{item.itemName}</p>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-red-600">{fmt(item.qtyOnHand)}</p>
                <p className="text-[10px] text-muted-foreground">Min: {fmt(item.reorderPoint)}</p>
              </div>
            </div>
          ))}
          {!items.length && <p className="text-sm text-muted-foreground text-center py-4">No stock alerts</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function WidgetPendingApprovals() {
  const { data, isLoading } = useGetDashboardWidgetType("pending-approvals", undefined, { query: { queryKey: getGetDashboardWidgetTypeQueryKey("pending-approvals") } });
  const items = (data?.data as unknown as PendingApprovalItem[] | undefined) ?? [];
  if (isLoading) return <Skeleton className="h-64" />;
  return (
    <Card className="col-span-1 lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Clock className="h-4 w-4 text-blue-500" />
          Action Required: Approvals
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>Requested By</TableHead>
              <TableHead className="text-right">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.slice(0, 5).map((app, i) => (
              <TableRow key={i}>
                <TableCell><Badge variant="secondary" className="capitalize">{app.type}</Badge></TableCell>
                <TableCell className="font-medium">{app.code}</TableCell>
                <TableCell>{app.requestedBy || "—"}</TableCell>
                <TableCell className="text-right font-medium">{fmt(app.amount, true)}</TableCell>
              </TableRow>
            ))}
            {!items.length && (
              <TableRow><TableCell colSpan={4} className="text-center py-6 text-muted-foreground">All caught up!</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function WidgetGlActivity() {
  const { data, isLoading } = useGetDashboardWidgetType("gl-activity", undefined, { query: { queryKey: getGetDashboardWidgetTypeQueryKey("gl-activity") } });
  const items = (data?.data as unknown as GlActivityItem[] | undefined) ?? [];
  if (isLoading) return <Skeleton className="h-64" />;
  return (
    <Card className="col-span-1 lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <FileBarChart className="h-4 w-4 text-emerald-500" />
          Recent GL Activity
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Journal</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Memo</TableHead>
              <TableHead className="text-right">Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.slice(0, 5).map((gl, i) => (
              <TableRow key={i}>
                <TableCell className="font-medium">{gl.code}</TableCell>
                <TableCell>{fmtDate(gl.postedAt)}</TableCell>
                <TableCell className="truncate max-w-[200px]">{gl.notes}</TableCell>
                <TableCell className="text-right font-medium">{fmt(gl.totalDebit, true)}</TableCell>
              </TableRow>
            ))}
            {!items.length && (
              <TableRow><TableCell colSpan={4} className="text-center py-6 text-muted-foreground">No recent postings</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ── Widget Library ─────────────────────────────────────────────────────────────

type UserRole = "admin" | "super_admin" | "tenant_admin" | "purchaser" | "warehouse" | "approver" | "accountant" | "viewer";

interface WidgetDef {
  id: string;
  label: string;
  availableRoles: UserRole[];
  Component: React.ComponentType;
}

const WIDGET_LIBRARY: WidgetDef[] = [
  { id: "recent-pos",        label: "Recent Purchase Orders", availableRoles: ["admin","super_admin","tenant_admin","purchaser","warehouse"],       Component: WidgetRecentPOs },
  { id: "recent-orders",     label: "Recent Sales Orders",    availableRoles: ["admin","super_admin","tenant_admin","accountant","warehouse"],       Component: WidgetRecentOrders },
  { id: "stock-alerts",      label: "Stock Alerts",           availableRoles: ["admin","super_admin","tenant_admin","warehouse","purchaser"],        Component: WidgetStockAlerts },
  { id: "pending-approvals", label: "Pending Approvals",      availableRoles: ["admin","super_admin","tenant_admin","approver","purchaser"],         Component: WidgetPendingApprovals },
  { id: "gl-activity",       label: "GL Activity",            availableRoles: ["admin","super_admin","tenant_admin","accountant"],                   Component: WidgetGlActivity },
];

const DEFAULT_WIDGETS: Record<string, string[]> = {
  admin:       ["recent-orders","recent-pos","stock-alerts","gl-activity"],
  super_admin: ["recent-orders","recent-pos","stock-alerts","gl-activity"],
  tenant_admin:["recent-orders","recent-pos","stock-alerts","gl-activity"],
  purchaser:   ["recent-pos","pending-approvals"],
  warehouse:   ["stock-alerts","recent-pos","recent-orders"],
  approver:    ["pending-approvals"],
  accountant:  ["gl-activity","recent-orders"],
  viewer:      ["recent-orders"],
};

function useWidgetPrefs(role: UserRole) {
  const storageKey = `dashboard-widgets-${role}`;
  const defaults = DEFAULT_WIDGETS[role] ?? DEFAULT_WIDGETS.viewer;
  const [ordered, setOrdered] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored ? (JSON.parse(stored) as string[]) : defaults;
    } catch { return defaults; }
  });

  const persist = (next: string[]) => {
    setOrdered(next);
    try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const toggle = (id: string) => {
    persist(ordered.includes(id) ? ordered.filter(w => w !== id) : [...ordered, id]);
  };

  const moveUp = (id: string) => {
    const idx = ordered.indexOf(id);
    if (idx <= 0) return;
    const next = [...ordered];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    persist(next);
  };

  const moveDown = (id: string) => {
    const idx = ordered.indexOf(id);
    if (idx < 0 || idx >= ordered.length - 1) return;
    const next = [...ordered];
    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
    persist(next);
  };

  return { enabled: ordered, toggle, moveUp, moveDown };
}

// ── KPI Card ───────────────────────────────────────────────────────────────────

function KpiCard({ title, value, icon: Icon, color }: { title: string; value: string | number | undefined; icon: LucideIcon; color: string }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <Icon className={`h-4 w-4 ${color}`} />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value ?? "0"}</div>
      </CardContent>
    </Card>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [customizing, setCustomizing] = useState(false);

  const { data: currentUser, isLoading: userLoading } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });

  const rawRole = currentUser?.role ?? "viewer";
  const role = rawRole as UserRole;
  const kpiRole = ((role === "super_admin" || role === "tenant_admin") ? "admin" : role) as GetDashboardKpiRole;

  const { data: kpiData, isLoading: kpiLoading } = useGetDashboardKpi(
    { role: kpiRole },
    { query: { enabled: !!rawRole, queryKey: getGetDashboardKpiQueryKey({ role: kpiRole }) } }
  );

  const { enabled: enabledWidgets, toggle, moveUp, moveDown } = useWidgetPrefs(role);

  const availableWidgets = useMemo(
    () => WIDGET_LIBRARY.filter(w => w.availableRoles.includes(role)),
    [role]
  );

  const visibleWidgets = useMemo(
    () => availableWidgets.filter(w => enabledWidgets.includes(w.id)),
    [availableWidgets, enabledWidgets]
  );

  if (userLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-5 w-48 mt-2" />
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-32" />)}
        </div>
      </div>
    );
  }

  const kpis = (kpiData?.kpis ?? {}) as AnyKpis;

  const renderKpis = () => {
    if (kpiLoading) return [1,2,3,4].map(i => <Skeleton key={i} className="h-32" />);
    if (role === "purchaser") return (<>
      <KpiCard title="Open POs"           value={kpis.openPOs}            icon={ShoppingCart} color="text-blue-500" />
      <KpiCard title="Awaiting Approval"  value={kpis.awaitingApproval}   icon={Clock}        color="text-orange-500" />
      <KpiCard title="To Receive"         value={kpis.itemsToReceive}     icon={Package}      color="text-indigo-500" />
      <KpiCard title="Spend MTD"          value={fmt(kpis.supplierSpendMtd, true)} icon={DollarSign} color="text-emerald-500" />
    </>);
    if (role === "warehouse") return (<>
      <KpiCard title="Pick Slips Ready"   value={kpis.pickSlipsReady}       icon={FileText}      color="text-blue-500" />
      <KpiCard title="To Receive Today"   value={kpis.itemsToReceiveToday}  icon={Package}       color="text-indigo-500" />
      <KpiCard title="Low Stock Alerts"   value={kpis.lowStockAlerts}       icon={AlertTriangle} color="text-red-500" />
      <KpiCard title="Pending Counts"     value={kpis.pendingCycleCounts}   icon={Activity}      color="text-orange-500" />
    </>);
    if (role === "approver") return (<>
      <KpiCard title="Pending Approvals"   value={kpis.pendingApprovals}                icon={Clock}         color="text-orange-500" />
      <KpiCard title="Approved MTD"        value={kpis.approvedMtd ?? 0}               icon={CheckCircle2}  color="text-emerald-500" />
      <KpiCard title="Avg Turnaround"      value={(kpis.avgTurnaroundHours ?? 0) + "h"} icon={Activity}      color="text-blue-500" />
      <KpiCard title="Total Value Pending" value={fmt(kpis.valuePending ?? 0, true)}   icon={DollarSign}    color="text-indigo-500" />
    </>);
    if (role === "accountant") return (<>
      <KpiCard title="Postings Today"      value={kpis.glPostingsToday}                        icon={FileText}    color="text-blue-500" />
      <KpiCard title="Draft Journals"      value={kpis.unreconciledDraftPostings}              icon={FileBarChart} color="text-orange-500" />
      <KpiCard title="Cash Flow MTD"       value={fmt(kpis.cashFlowEstimateMtd ?? 0, true)}   icon={TrendingUp}  color="text-emerald-500" />
      <KpiCard title="A/R Outstanding"     value={fmt(kpis.outstandingReceivables, true)}      icon={DollarSign}  color="text-indigo-500" />
    </>);
    return (<>
      <KpiCard title="Open POs"           value={kpis.openPOs}                   icon={ShoppingCart} color="text-blue-500" />
      <KpiCard title="Sales MTD"          value={fmt(kpis.salesMtdValue, true)}  icon={TrendingUp}   color="text-emerald-500" />
      <KpiCard title="Active Sales Orders" value={kpis.activeSalesOrders ?? 0}  icon={FileText}     color="text-orange-500" />
      <KpiCard title="Low Stock"          value={kpis.lowStockAlerts}            icon={AlertTriangle} color="text-red-500" />
    </>);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">
            Welcome back, {currentUser?.firstName || currentUser?.email?.split("@")[0]}
          </h2>
          <p className="text-muted-foreground">
            Here's what's happening at {currentUser?.tenantName || "your company"} today.
          </p>
        </div>
        {availableWidgets.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => setCustomizing(true)} className="gap-2">
            <Settings2 className="h-4 w-4" />
            Customize
          </Button>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {renderKpis()}
      </div>

      {role === "approver" && !kpiLoading && (kpis.recentDecisions?.length ?? 0) > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              Recent Approval Decisions
            </CardTitle>
            <CardDescription>Your latest approval activity</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Document</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Decision</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(kpis.recentDecisions ?? []).map((d, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono font-medium">{d.code}</TableCell>
                    <TableCell className="capitalize text-muted-foreground">{d.type.replace(/_/g, " ")}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(d.amount, true)}</TableCell>
                    <TableCell>
                      <Badge variant={d.decision === "approved" ? "default" : "destructive"} className="capitalize">{d.decision}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{fmtDate(d.decidedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {role === "accountant" && !kpiLoading && (
        <div className="grid gap-4 md:grid-cols-3">
          <Card className="border-emerald-200 bg-emerald-50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-emerald-700">Cash Inflow MTD</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-emerald-700">{fmt(kpis.cashInflowMtd ?? 0, true)}</p>
              <p className="text-xs text-emerald-600 mt-1">Estimated receipts this month</p>
            </CardContent>
          </Card>
          <Card className="border-red-200 bg-red-50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-red-700">Cash Outflow MTD</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold text-red-700">{fmt(kpis.cashOutflowMtd ?? 0, true)}</p>
              <p className="text-xs text-red-600 mt-1">Estimated payments this month</p>
            </CardContent>
          </Card>
          <Card className={`border-2 ${(kpis.cashFlowEstimateMtd ?? 0) >= 0 ? "border-emerald-300 bg-emerald-50" : "border-red-300 bg-red-50"}`}>
            <CardHeader className="pb-2">
              <CardTitle className={`text-sm font-medium ${(kpis.cashFlowEstimateMtd ?? 0) >= 0 ? "text-emerald-700" : "text-red-700"}`}>Net Cash Flow MTD</CardTitle>
            </CardHeader>
            <CardContent>
              <p className={`text-2xl font-bold ${(kpis.cashFlowEstimateMtd ?? 0) >= 0 ? "text-emerald-700" : "text-red-700"}`}>{fmt(kpis.cashFlowEstimateMtd ?? 0, true)}</p>
              <p className="text-xs text-muted-foreground mt-1">Inflow minus outflow</p>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {visibleWidgets.map(({ id, Component }) => <Component key={id} />)}
        {visibleWidgets.length === 0 && (
          <Card className="col-span-3">
            <CardContent className="py-12 text-center text-muted-foreground">
              <PackageSearch className="mx-auto h-10 w-10 mb-3 opacity-40" />
              <p>No widgets selected.</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => setCustomizing(true)}>Add widgets</Button>
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={customizing} onOpenChange={setCustomizing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowUpDown className="h-4 w-4" />
              Customize Dashboard
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2 pt-2">
            <p className="text-sm text-muted-foreground">Toggle widgets and drag them up/down to reorder.</p>
            {enabledWidgets
              .filter(id => availableWidgets.some(w => w.id === id))
              .concat(availableWidgets.filter(w => !enabledWidgets.includes(w.id)).map(w => w.id))
              .map((id, idx, arr) => {
                const w = availableWidgets.find(x => x.id === id);
                if (!w) return null;
                const isEnabled = enabledWidgets.includes(id);
                return (
                  <div key={id} className={`flex items-center gap-3 p-2 rounded-md ${isEnabled ? "bg-muted/50" : ""}`}>
                    <Checkbox
                      id={`widget-${id}`}
                      checked={isEnabled}
                      onCheckedChange={() => toggle(id)}
                    />
                    <Label htmlFor={`widget-${id}`} className="flex-1 cursor-pointer">{w.label}</Label>
                    {isEnabled && (
                      <div className="flex gap-1">
                        <Button
                          variant="ghost" size="sm" className="h-6 w-6 p-0"
                          disabled={idx === 0}
                          onClick={() => moveUp(id)}
                          title="Move up"
                        >
                          <ChevronUp className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost" size="sm" className="h-6 w-6 p-0"
                          disabled={idx >= enabledWidgets.filter(e => availableWidgets.some(x => x.id === e)).length - 1}
                          onClick={() => moveDown(id)}
                          title="Move down"
                        >
                          <ChevronDown className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
