import { useState } from "react";
import { 
  useGetCurrentUser, 
  getGetCurrentUserQueryKey,
  useGetDashboardKpi,
  getGetDashboardKpiQueryKey,
  useGetDashboardWidgetType,
  getGetDashboardWidgetTypeQueryKey
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  Calculator, PackageSearch, Receipt, ShoppingCart, 
  AlertTriangle, CheckCircle2, DollarSign, Activity,
  TrendingUp, Clock, Package, FileText, FileBarChart
} from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

function fmt(n: any, isCurrency = false) {
  if (n == null) return "—";
  const num = Number(n);
  if (isCurrency) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
  }
  return new Intl.NumberFormat('en-US').format(num);
}

function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString();
}

function WidgetRecentPOs() {
  const { data, isLoading } = useGetDashboardWidgetType("recent-pos", undefined, { query: { queryKey: getGetDashboardWidgetTypeQueryKey("recent-pos") } });
  
  if (isLoading) return <Skeleton className="h-64" />;
  
  return (
    <Card className="col-span-1 lg:col-span-1">
      <CardHeader>
        <CardTitle className="text-lg">Recent Purchase Orders</CardTitle>
        <CardDescription>Latest procurement activity</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {(data as any[])?.slice(0, 5).map((po: any) => (
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
          {!(data as any[])?.length && <p className="text-sm text-muted-foreground text-center py-4">No recent POs</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function WidgetRecentOrders() {
  const { data, isLoading } = useGetDashboardWidgetType("recent-orders", undefined, { query: { queryKey: getGetDashboardWidgetTypeQueryKey("recent-orders") } });
  
  if (isLoading) return <Skeleton className="h-64" />;
  
  return (
    <Card className="col-span-1 lg:col-span-1">
      <CardHeader>
        <CardTitle className="text-lg">Recent Sales</CardTitle>
        <CardDescription>Latest customer orders</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {(data as any[])?.slice(0, 5).map((so: any) => (
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
          {!(data as any[])?.length && <p className="text-sm text-muted-foreground text-center py-4">No recent orders</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function WidgetStockAlerts() {
  const { data, isLoading } = useGetDashboardWidgetType("stock-alerts", undefined, { query: { queryKey: getGetDashboardWidgetTypeQueryKey("stock-alerts") } });
  
  if (isLoading) return <Skeleton className="h-64" />;
  
  return (
    <Card className="col-span-1 lg:col-span-1">
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-orange-500" />
          Stock Alerts
        </CardTitle>
        <CardDescription>Items below reorder point</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {(data as any[])?.slice(0, 5).map((item: any, i) => (
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
          {!(data as any[])?.length && <p className="text-sm text-muted-foreground text-center py-4">No stock alerts</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function WidgetPendingApprovals() {
  const { data, isLoading } = useGetDashboardWidgetType("pending-approvals", undefined, { query: { queryKey: getGetDashboardWidgetTypeQueryKey("pending-approvals") } });
  
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
            {(data as any[])?.slice(0, 5).map((app: any, i) => (
              <TableRow key={i}>
                <TableCell><Badge variant="secondary" className="capitalize">{app.type}</Badge></TableCell>
                <TableCell className="font-medium">{app.code}</TableCell>
                <TableCell>{app.requestedBy || "—"}</TableCell>
                <TableCell className="text-right font-medium">{fmt(app.amount, true)}</TableCell>
              </TableRow>
            ))}
            {!(data as any[])?.length && (
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
            {(data as any[])?.slice(0, 5).map((gl: any, i) => (
              <TableRow key={i}>
                <TableCell className="font-medium">{gl.code}</TableCell>
                <TableCell>{fmtDate(gl.postedAt)}</TableCell>
                <TableCell className="truncate max-w-[200px]">{gl.memo}</TableCell>
                <TableCell className="text-right font-medium">{fmt(gl.totalDebit, true)}</TableCell>
              </TableRow>
            ))}
            {!(data as any[])?.length && (
              <TableRow><TableCell colSpan={4} className="text-center py-6 text-muted-foreground">No recent postings</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const { data: currentUser, isLoading: userLoading } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });

  const role = (currentUser?.role || "viewer") as any;
  const { data: kpiData, isLoading: kpiLoading } = useGetDashboardKpi(
    { role: role === "super_admin" || role === "tenant_admin" ? "admin" : role },
    { query: { enabled: !!role, queryKey: getGetDashboardKpiQueryKey({ role: role === "super_admin" || role === "tenant_admin" ? "admin" : role }) } }
  );

  if (userLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-5 w-48 mt-2" />
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </div>
    );
  }

  const renderKpis = () => {
    if (kpiLoading) return [1,2,3,4].map(i => <Skeleton key={i} className="h-32" />);
    
    const kpis = kpiData?.kpis || {} as any;
    
    if (role === "purchaser") {
      return (
        <>
          <KpiCard title="Open POs" value={kpis.openPOs} icon={ShoppingCart} color="text-blue-500" />
          <KpiCard title="Awaiting Approval" value={kpis.awaitingApproval} icon={Clock} color="text-orange-500" />
          <KpiCard title="To Receive" value={kpis.itemsToReceive} icon={Package} color="text-indigo-500" />
          <KpiCard title="Spend MTD" value={fmt(kpis.supplierSpendMtd, true)} icon={DollarSign} color="text-emerald-500" />
        </>
      );
    }
    if (role === "warehouse") {
      return (
        <>
          <KpiCard title="Pick Slips Ready" value={kpis.pickSlipsReady} icon={FileText} color="text-blue-500" />
          <KpiCard title="To Receive Today" value={kpis.itemsToReceiveToday} icon={Package} color="text-indigo-500" />
          <KpiCard title="Low Stock Alerts" value={kpis.lowStockAlerts} icon={AlertTriangle} color="text-red-500" />
          <KpiCard title="Pending Counts" value={kpis.pendingCycleCounts} icon={Activity} color="text-orange-500" />
        </>
      );
    }
    if (role === "approver") {
      return (
        <>
          <KpiCard title="Pending Approvals" value={kpis.pendingApprovals} icon={Clock} color="text-orange-500" />
          <KpiCard title="Approved MTD" value={kpis.approvedMtd ?? "0"} icon={CheckCircle2} color="text-emerald-500" />
          <KpiCard title="Avg Turnaround" value={(kpis.avgTurnaroundHours ?? "0") + "h"} icon={Activity} color="text-blue-500" />
          <KpiCard title="Total Value Pending" value={fmt(kpis.valuePending ?? 0, true)} icon={DollarSign} color="text-indigo-500" />
        </>
      );
    }
    if (role === "accountant") {
      return (
        <>
          <KpiCard title="Postings Today" value={kpis.glPostingsToday} icon={FileText} color="text-blue-500" />
          <KpiCard title="Draft Journals" value={kpis.unreconciledDraftPostings} icon={FileBarChart} color="text-orange-500" />
          <KpiCard title="A/R Outstanding" value={fmt(kpis.outstandingReceivables, true)} icon={DollarSign} color="text-emerald-500" />
          <KpiCard title="Trial Bal (Debit)" value={fmt(kpis.trialBalanceTotalDebit, true)} icon={Calculator} color="text-indigo-500" />
        </>
      );
    }
    
    // Default admin view
    return (
      <>
        <KpiCard title="Open POs" value={kpis.openPOs} icon={ShoppingCart} color="text-blue-500" />
        <KpiCard title="Sales MTD" value={fmt(kpis.salesMtd, true)} icon={TrendingUp} color="text-emerald-500" />
        <KpiCard title="Low Stock" value={kpis.lowStockAlerts} icon={AlertTriangle} color="text-red-500" />
        <KpiCard title="Postings (Week)" value={kpis.glPostingsThisWeek} icon={Calculator} color="text-indigo-500" />
      </>
    );
  };

  const renderWidgets = () => {
    if (role === "purchaser") return <><WidgetRecentPOs /><WidgetPendingApprovals /></>;
    if (role === "warehouse") return <><WidgetStockAlerts /><WidgetRecentPOs /><WidgetRecentOrders /></>;
    if (role === "approver") return <><WidgetPendingApprovals /></>;
    if (role === "accountant") return <><WidgetGlActivity /><WidgetRecentOrders /></>;
    
    // Admin
    return (
      <>
        <WidgetRecentOrders />
        <WidgetRecentPOs />
        <WidgetStockAlerts />
        <WidgetGlActivity />
      </>
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Welcome back, {currentUser?.firstName || currentUser?.email?.split('@')[0]}</h2>
        <p className="text-muted-foreground">
          Here's what's happening at {currentUser?.tenantName || "your company"} today.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {renderKpis()}
      </div>
      
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {renderWidgets()}
      </div>
    </div>
  );
}

function KpiCard({ title, value, icon: Icon, color }: { title: string, value: any, icon: any, color: string }) {
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
