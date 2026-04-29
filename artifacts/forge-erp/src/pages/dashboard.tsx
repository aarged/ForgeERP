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
  Settings2
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

interface AdminKpis {
  openPOs: number;
  salesMtdValue: number;
  lowStockAlerts: number;
  glPostingsThisWeek: number;
}
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
}
interface AccountantKpis {
  glPostingsToday: number;
  unreconciledDraftPostings: number;
  outstandingReceivables: number;
  trialBalanceTotalDebit: number;
}
type AnyKpis = Partial<AdminKpis & PurchaserKpis & WarehouseKpis & ApproverKpis & AccountantKpis>;

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
  const [enabled, setEnabled] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored ? (JSON.parse(stored) as string[]) : defaults;
    } catch { return defaults; }
  });

  const toggle = (id: string) => {
    setEnabled(prev => {
      const next = prev.includes(id) ? prev.filter(w => w !== id) : [...prev, id];
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  return { enabled, toggle };
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

  const { enabled: enabledWidgets, toggle } = useWidgetPrefs(role);

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
      <KpiCard title="Pending Approvals"  value={kpis.pendingApprovals}                   icon={Clock}         color="text-orange-500" />
      <KpiCard title="Approved MTD"       value={kpis.approvedMtd ?? 0}                   icon={CheckCircle2}  color="text-emerald-500" />
      <KpiCard title="Avg Turnaround"     value={(kpis.avgTurnaroundHours ?? 0) + "h"}    icon={Activity}      color="text-blue-500" />
      <KpiCard title="Total Value Pending"value={fmt(kpis.valuePending ?? 0, true)}       icon={DollarSign}    color="text-indigo-500" />
    </>);
    if (role === "accountant") return (<>
      <KpiCard title="Postings Today"     value={kpis.glPostingsToday}            icon={FileText}    color="text-blue-500" />
      <KpiCard title="Draft Journals"     value={kpis.unreconciledDraftPostings}  icon={FileBarChart} color="text-orange-500" />
      <KpiCard title="A/R Outstanding"   value={fmt(kpis.outstandingReceivables, true)}  icon={DollarSign} color="text-emerald-500" />
      <KpiCard title="Trial Bal (Debit)" value={fmt(kpis.trialBalanceTotalDebit, true)}  icon={Calculator} color="text-indigo-500" />
    </>);
    return (<>
      <KpiCard title="Open POs"       value={kpis.openPOs}                   icon={ShoppingCart} color="text-blue-500" />
      <KpiCard title="Sales MTD"      value={fmt(kpis.salesMtdValue, true)}  icon={TrendingUp}   color="text-emerald-500" />
      <KpiCard title="Low Stock"      value={kpis.lowStockAlerts}            icon={AlertTriangle} color="text-red-500" />
      <KpiCard title="Postings (Week)"value={kpis.glPostingsThisWeek}        icon={Calculator}   color="text-indigo-500" />
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
            <DialogTitle>Customize Dashboard</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 pt-2">
            <p className="text-sm text-muted-foreground">Select which widgets to display on your dashboard.</p>
            {availableWidgets.map(w => (
              <div key={w.id} className="flex items-center gap-3">
                <Checkbox
                  id={`widget-${w.id}`}
                  checked={enabledWidgets.includes(w.id)}
                  onCheckedChange={() => toggle(w.id)}
                />
                <Label htmlFor={`widget-${w.id}`} className="cursor-pointer">{w.label}</Label>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
