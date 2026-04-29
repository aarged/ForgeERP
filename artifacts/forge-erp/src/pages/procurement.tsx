import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm, Controller, useFieldArray } from "react-hook-form";
import {
  useListApprovalWorkflows,
  useCreateApprovalWorkflow,
  useUpdateApprovalWorkflow,
  useListApprovalSteps,
  useCreateApprovalStep,
  useDeleteApprovalStep,
  useListRequisitions,
  useGetRequisition,
  useCreateRequisition,
  useUpdateRequisition,
  useDeleteRequisition,
  useSubmitRequisition,
  useDecideRequisition,
  useConvertRequisitionToPo,
  getListRequisitionsQueryKey,
  getGetRequisitionQueryKey,
  useListPurchaseOrders,
  useGetPurchaseOrder,
  useCreatePurchaseOrder,
  useDeletePurchaseOrder,
  useSubmitPurchaseOrder,
  useDecidePurchaseOrder,
  useSendPurchaseOrder,
  getListPurchaseOrdersQueryKey,
  getGetPurchaseOrderQueryKey,
  useListReceipts,
  useCreateReceipt,
  useConfirmReceipt,
  getListReceiptsQueryKey,
  getGetReceiptQueryKey,
  useListReturns,
  useCreateReturn,
  useConfirmReturn,
  getListReturnsQueryKey,
  useListGlPostings,
  useListInventoryStock,
  useReportPendingApprovals,
  useReportSupplierPerformance,
  useReportPoSummary,
  useReportOpenPos,
  getListApprovalWorkflowsQueryKey,
  getListApprovalStepsQueryKey,
  useListSuppliers,
  useListWarehouses,
  useGeneratePurchaseOrderPdf,
} from "@workspace/api-client-react";
import type {
  PurchaseRequisition,
  PurchaseOrder,
  PoReceipt,
  PoReturn,
  ApprovalWorkflow,
  RequisitionLineInput,
  PoLineInput,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  MoreHorizontal,
  Plus,
  Search,
  Pencil,
  Trash2,
  ShoppingCart,
  Loader2,
  ChevronRight,
  CheckCircle2,
  XCircle,
  TruckIcon,
  BarChart2,
  ArrowLeft,
  RotateCcw,
  FileText,
  Send,
  ClipboardCheck,
  Boxes,
  BookOpen,
  Settings,
  AlertCircle,
} from "lucide-react";

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmtDate(d: string | Date | null | undefined) {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-AU", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(d));
}

function fmtDateTime(d: string | Date | null | undefined) {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(new Date(d));
}

function fmtCurrency(v: string | number | null | undefined, currency = "AUD") {
  if (v == null || v === "") return "—";
  return new Intl.NumberFormat("en-AU", { style: "currency", currency, minimumFractionDigits: 2 }).format(Number(v));
}

function fmtNum(v: string | number | null | undefined, dp = 2) {
  if (v == null || v === "") return "—";
  return Number(v).toFixed(dp);
}

function FormField({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium">
        {label}{required && <span className="text-destructive ml-1">*</span>}
      </Label>
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: string | null | undefined }) {
  const cfg: Record<string, { label: string; className: string }> = {
    draft: { label: "Draft", className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
    pending_approval: { label: "Pending Approval", className: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400" },
    approved: { label: "Approved", className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" },
    rejected: { label: "Rejected", className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400" },
    returned: { label: "Returned", className: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400" },
    converted: { label: "Converted", className: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400" },
    sent: { label: "Sent", className: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-400" },
    receiving: { label: "Receiving", className: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-400" },
    partially_received: { label: "Part. Received", className: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400" },
    received: { label: "Received", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400" },
    confirmed: { label: "Confirmed", className: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400" },
    cancelled: { label: "Cancelled", className: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400" },
    posted: { label: "Posted", className: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400" },
  };
  const s = status ?? "draft";
  const c = cfg[s] ?? { label: s, className: "bg-slate-100 text-slate-700" };
  return <Badge variant="secondary" className={c.className}>{c.label}</Badge>;
}

function PriorityBadge({ priority }: { priority: string | null | undefined }) {
  const cfg: Record<string, string> = {
    low: "bg-slate-100 text-slate-600",
    normal: "bg-blue-100 text-blue-800",
    urgent: "bg-red-100 text-red-800",
  };
  return <Badge variant="secondary" className={cfg[priority ?? "normal"] ?? ""}>{priority ?? "normal"}</Badge>;
}

function EmptyState({ icon: Icon, title, description }: { icon: React.ElementType; title: string; description: string }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center text-center gap-3">
      <Icon className="h-12 w-12 text-muted-foreground/40" />
      <div>
        <p className="font-medium text-muted-foreground">{title}</p>
        <p className="text-sm text-muted-foreground/70">{description}</p>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function Procurement() {
  const [activeTab, setActiveTab] = useState("dashboard");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Procurement</h2>
        <p className="text-muted-foreground">Manage requisitions, purchase orders, and goods receipts.</p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="overflow-x-auto">
          <TabsList className="inline-flex h-10 min-w-max">
            <TabsTrigger value="dashboard" className="flex items-center gap-1.5"><BarChart2 className="h-4 w-4" />Dashboard</TabsTrigger>
            <TabsTrigger value="requisitions" className="flex items-center gap-1.5"><FileText className="h-4 w-4" />Requisitions</TabsTrigger>
            <TabsTrigger value="purchase-orders" className="flex items-center gap-1.5"><ShoppingCart className="h-4 w-4" />Purchase Orders</TabsTrigger>
            <TabsTrigger value="receipts" className="flex items-center gap-1.5"><ClipboardCheck className="h-4 w-4" />Goods Receipts</TabsTrigger>
            <TabsTrigger value="returns" className="flex items-center gap-1.5"><RotateCcw className="h-4 w-4" />Returns</TabsTrigger>
            <TabsTrigger value="inventory" className="flex items-center gap-1.5"><Boxes className="h-4 w-4" />Inventory</TabsTrigger>
            <TabsTrigger value="gl-postings" className="flex items-center gap-1.5"><BookOpen className="h-4 w-4" />GL Postings</TabsTrigger>
            <TabsTrigger value="workflows" className="flex items-center gap-1.5"><Settings className="h-4 w-4" />Workflows</TabsTrigger>
            <TabsTrigger value="reports" className="flex items-center gap-1.5"><BarChart2 className="h-4 w-4" />Reports</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="dashboard"><DashboardTab onNavigate={setActiveTab} /></TabsContent>
        <TabsContent value="requisitions"><RequisitionsTab /></TabsContent>
        <TabsContent value="purchase-orders"><PurchaseOrdersTab /></TabsContent>
        <TabsContent value="receipts"><ReceiptsTab /></TabsContent>
        <TabsContent value="returns"><ReturnsTab /></TabsContent>
        <TabsContent value="inventory"><InventoryTab /></TabsContent>
        <TabsContent value="gl-postings"><GlPostingsTab /></TabsContent>
        <TabsContent value="workflows"><WorkflowsTab /></TabsContent>
        <TabsContent value="reports"><ReportsTab /></TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function DashboardTab({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const { data: pendingData, isLoading: pendingLoading } = useReportPendingApprovals();
  const { data: openPos, isLoading: openPosLoading } = useReportOpenPos();
  const { data: summary, isLoading: summaryLoading } = useReportPoSummary({});

  const totalPending = (pendingData as { totalPending?: number })?.totalPending ?? 0;
  const pendingReqs = (pendingData as { pendingRequisitions?: PurchaseRequisition[] })?.pendingRequisitions ?? [];
  const pendingPos = (pendingData as { pendingPurchaseOrders?: PurchaseOrder[] })?.pendingPurchaseOrders ?? [];
  const openPosArr = Array.isArray(openPos) ? (openPos as PurchaseOrder[]) : [];

  const summaryArr = Array.isArray(summary) ? (summary as { status: string; count: number; total: number }[]) : [];
  const totalValue = summaryArr.reduce((s, r) => s + Number(r.total ?? 0), 0);
  const totalOrders = summaryArr.reduce((s, r) => s + Number(r.count ?? 0), 0);
  const receivedOrders = summaryArr.find((r) => r.status === "received");

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Pending Approvals</CardTitle>
            <AlertCircle className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            {pendingLoading ? <Skeleton className="h-8 w-16" /> : (
              <>
                <div className="text-3xl font-bold">{totalPending}</div>
                <p className="text-xs text-muted-foreground mt-1">{pendingReqs.length} req · {pendingPos.length} PO</p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Open POs</CardTitle>
            <ShoppingCart className="h-4 w-4 text-blue-500" />
          </CardHeader>
          <CardContent>
            {openPosLoading ? <Skeleton className="h-8 w-16" /> : (
              <>
                <div className="text-3xl font-bold">{openPosArr.length}</div>
                <p className="text-xs text-muted-foreground mt-1">Awaiting receipt</p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Total PO Value</CardTitle>
            <TruckIcon className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            {summaryLoading ? <Skeleton className="h-8 w-24" /> : (
              <>
                <div className="text-2xl font-bold">{fmtCurrency(totalValue)}</div>
                <p className="text-xs text-muted-foreground mt-1">{totalOrders} orders</p>
              </>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Received</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            {summaryLoading ? <Skeleton className="h-8 w-16" /> : (
              <>
                <div className="text-3xl font-bold">{receivedOrders?.count ?? 0}</div>
                <p className="text-xs text-muted-foreground mt-1">{fmtCurrency(receivedOrders?.total)} value</p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Pending Approvals</CardTitle>
            {totalPending > 0 && (
              <Button variant="ghost" size="sm" onClick={() => onNavigate("requisitions")}>
                View all <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {pendingLoading ? <Skeleton className="h-32" /> : totalPending === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
                <CheckCircle2 className="h-8 w-8 text-green-400" />
                <p className="text-sm">No pending approvals</p>
              </div>
            ) : (
              <div className="space-y-2">
                {pendingReqs.slice(0, 3).map((r) => (
                  <div key={r.id} className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <p className="font-medium text-sm">{r.code}</p>
                      <p className="text-xs text-muted-foreground">{r.title}</p>
                    </div>
                    <div className="text-right">
                      <StatusBadge status="pending_approval" />
                      <p className="text-xs text-muted-foreground mt-1">{fmtCurrency(r.totalEstimated)}</p>
                    </div>
                  </div>
                ))}
                {pendingPos.slice(0, 3).map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <p className="font-medium text-sm">{p.code}</p>
                      <p className="text-xs text-muted-foreground">{p.supplierName ?? "No supplier"}</p>
                    </div>
                    <div className="text-right">
                      <StatusBadge status="pending_approval" />
                      <p className="text-xs text-muted-foreground mt-1">{fmtCurrency(p.total)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Open Purchase Orders</CardTitle>
            {openPosArr.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => onNavigate("purchase-orders")}>
                View all <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {openPosLoading ? <Skeleton className="h-32" /> : openPosArr.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
                <ShoppingCart className="h-8 w-8 text-muted-foreground/40" />
                <p className="text-sm">No open purchase orders</p>
              </div>
            ) : (
              <div className="space-y-2">
                {openPosArr.slice(0, 5).map((po) => (
                  <div key={po.id} className="flex items-center justify-between rounded-lg border p-3">
                    <div>
                      <p className="font-medium text-sm">{po.code}</p>
                      <p className="text-xs text-muted-foreground">{po.supplierName ?? "No supplier"} · Due {fmtDate(po.deliveryDate)}</p>
                    </div>
                    <div className="text-right">
                      <StatusBadge status={po.status} />
                      <p className="text-xs text-muted-foreground mt-1">{fmtCurrency(po.total)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Requisitions ─────────────────────────────────────────────────────────────

function RequisitionsTab() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState("__all__");
  const [q, setQ] = useState("");
  const [decisionDialog, setDecisionDialog] = useState<{ id: number; action: "approved" | "rejected" | "returned" } | null>(null);

  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useListRequisitions({ status: statusFilter === "__all__" ? undefined : statusFilter, q: q || undefined });
  const { data: detail } = useGetRequisition(selectedId!, { query: { enabled: selectedId != null, queryKey: getGetRequisitionQueryKey(selectedId!) } });

  const reqs: PurchaseRequisition[] = (data as { requisitions?: PurchaseRequisition[] })?.requisitions ?? [];

  const deleteMut = useDeleteRequisition();
  const submitMut = useSubmitRequisition();
  const decisionMut = useDecideRequisition();
  const convertMut = useConvertRequisitionToPo();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListRequisitionsQueryKey() });
    if (selectedId) qc.invalidateQueries({ queryKey: getGetRequisitionQueryKey(selectedId) });
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this requisition?")) return;
    await deleteMut.mutateAsync({ id });
    toast({ title: "Requisition deleted" });
    invalidate();
    if (selectedId === id) setSelectedId(null);
  };

  const handleSubmit = async (id: number) => {
    await submitMut.mutateAsync({ id });
    toast({ title: "Submitted for approval" });
    invalidate();
  };

  const handleConvert = async (id: number) => {
    const po = await convertMut.mutateAsync({ id });
    toast({ title: `Purchase order ${(po as PurchaseOrder).code} created` });
    invalidate();
    qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
  };

  if (selectedId != null) {
    return (
      <RequisitionDetail
        id={selectedId}
        detail={detail}
        onBack={() => setSelectedId(null)}
        onRefresh={invalidate}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-2 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search..." className="pl-8 w-48" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="pending_approval">Pending Approval</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="converted">Converted</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setShowCreate(true)}><Plus className="mr-2 h-4 w-4" />New Requisition</Button>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead><TableHead>Title</TableHead><TableHead>Status</TableHead>
              <TableHead>Priority</TableHead><TableHead>Est. Total</TableHead><TableHead>Required By</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}><TableCell colSpan={7}><Skeleton className="h-5" /></TableCell></TableRow>
              ))
            ) : reqs.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">No requisitions found</TableCell></TableRow>
            ) : reqs.map((r) => (
              <TableRow key={r.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelectedId(r.id!)}>
                <TableCell className="font-mono text-sm font-medium">{r.code}</TableCell>
                <TableCell>{r.title}</TableCell>
                <TableCell><StatusBadge status={r.status} /></TableCell>
                <TableCell><PriorityBadge priority={r.priority} /></TableCell>
                <TableCell>{fmtCurrency(r.totalEstimated)}</TableCell>
                <TableCell>{fmtDate(r.requiredByDate)}</TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setSelectedId(r.id!)}><Pencil className="mr-2 h-4 w-4" />Open</DropdownMenuItem>
                      {r.status === "draft" && (
                        <DropdownMenuItem onClick={() => handleSubmit(r.id!)} disabled={submitMut.isPending}>
                          <Send className="mr-2 h-4 w-4" />Submit for Approval
                        </DropdownMenuItem>
                      )}
                      {r.status === "pending_approval" && (
                        <>
                          <DropdownMenuItem onClick={() => setDecisionDialog({ id: r.id!, action: "approved" })}><CheckCircle2 className="mr-2 h-4 w-4" />Approve</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setDecisionDialog({ id: r.id!, action: "rejected" })}><XCircle className="mr-2 h-4 w-4" />Reject</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setDecisionDialog({ id: r.id!, action: "returned" })}><RotateCcw className="mr-2 h-4 w-4" />Return</DropdownMenuItem>
                        </>
                      )}
                      {r.status === "approved" && (
                        <DropdownMenuItem onClick={() => handleConvert(r.id!)} disabled={convertMut.isPending}>
                          <ShoppingCart className="mr-2 h-4 w-4" />Convert to PO
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive" onClick={() => handleDelete(r.id!)} disabled={deleteMut.isPending}>
                        <Trash2 className="mr-2 h-4 w-4" />Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <RequisitionCreateDialog open={showCreate} onClose={() => setShowCreate(false)} onSaved={invalidate} />

      {decisionDialog && (
        <DecisionDialog
          open
          title={decisionDialog.action === "approved" ? "Approve Requisition" : decisionDialog.action === "rejected" ? "Reject Requisition" : "Return Requisition"}
          onClose={() => setDecisionDialog(null)}
          onConfirm={async (comment) => {
            await decisionMut.mutateAsync({ id: decisionDialog.id, data: { decision: decisionDialog.action, comment } });
            toast({ title: `Requisition ${decisionDialog.action}` });
            invalidate();
            setDecisionDialog(null);
          }}
          isPending={decisionMut.isPending}
        />
      )}
    </div>
  );
}

type ReqDetail = PurchaseRequisition & { lines?: RequisitionLineInput[]; approvalDecisions?: { id: number; decision: string; approverEmail?: string; comment?: string; createdAt: string }[] };

function RequisitionDetail({ id, detail, onBack, onRefresh }: { id: number; detail: unknown; onBack: () => void; onRefresh: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showEdit, setShowEdit] = useState(false);
  const [decisionDialog, setDecisionDialog] = useState<{ action: "approved" | "rejected" | "returned" } | null>(null);
  const submitMut = useSubmitRequisition();
  const decisionMut = useDecideRequisition();
  const convertMut = useConvertRequisitionToPo();
  const req = detail as ReqDetail | undefined;

  const inv = () => {
    qc.invalidateQueries({ queryKey: getGetRequisitionQueryKey(id) });
    onRefresh();
  };

  if (!req) return <Skeleton className="h-96" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4 mr-1" />Back</Button>
        <div className="flex-1">
          <h3 className="text-xl font-bold">{req.code} — {req.title}</h3>
          <div className="flex items-center gap-2 mt-1">
            <StatusBadge status={req.status} /><PriorityBadge priority={req.priority} />
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          {req.status === "draft" && (
            <>
              <Button variant="outline" size="sm" onClick={() => setShowEdit(true)}><Pencil className="mr-2 h-4 w-4" />Edit</Button>
              <Button size="sm" onClick={() => submitMut.mutateAsync({ id }).then(() => { toast({ title: "Submitted" }); inv(); })} disabled={submitMut.isPending}>
                {submitMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}<Send className="mr-2 h-4 w-4" />Submit
              </Button>
            </>
          )}
          {req.status === "pending_approval" && (
            <>
              <Button size="sm" variant="outline" className="text-green-700" onClick={() => setDecisionDialog({ action: "approved" })}><CheckCircle2 className="mr-2 h-4 w-4" />Approve</Button>
              <Button size="sm" variant="outline" className="text-destructive" onClick={() => setDecisionDialog({ action: "rejected" })}><XCircle className="mr-2 h-4 w-4" />Reject</Button>
              <Button size="sm" variant="outline" onClick={() => setDecisionDialog({ action: "returned" })}><RotateCcw className="mr-2 h-4 w-4" />Return</Button>
            </>
          )}
          {req.status === "approved" && (
            <Button size="sm" onClick={() => convertMut.mutateAsync({ id }).then((po) => { toast({ title: `PO ${(po as PurchaseOrder).code} created` }); inv(); qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() }); })} disabled={convertMut.isPending}>
              {convertMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}<ShoppingCart className="mr-2 h-4 w-4" />Convert to PO
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card><CardContent className="pt-4 space-y-3">
          <div><p className="text-xs text-muted-foreground">Requested By</p><p className="font-medium text-sm">{req.requestedByEmail ?? "—"}</p></div>
          <div><p className="text-xs text-muted-foreground">Required By</p><p className="font-medium text-sm">{fmtDate(req.requiredByDate)}</p></div>
        </CardContent></Card>
        <Card><CardContent className="pt-4 space-y-3">
          <div><p className="text-xs text-muted-foreground">Currency</p><p className="font-medium text-sm">{req.currencyCode}</p></div>
          <div><p className="text-xs text-muted-foreground">Est. Total</p><p className="font-bold text-lg">{fmtCurrency(req.totalEstimated, req.currencyCode ?? "AUD")}</p></div>
        </CardContent></Card>
        <Card><CardContent className="pt-4">
          <p className="text-xs text-muted-foreground">Notes</p><p className="text-sm mt-1">{req.notes ?? "—"}</p>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Lines</CardTitle></CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead><TableHead>Item</TableHead><TableHead>Description</TableHead>
              <TableHead className="text-right">Qty</TableHead><TableHead>UoM</TableHead>
              <TableHead className="text-right">Unit Price</TableHead><TableHead className="text-right">Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(req.lines ?? []).length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center py-6 text-muted-foreground">No lines</TableCell></TableRow>
            ) : (req.lines ?? []).map((l, i) => (
              <TableRow key={i}>
                <TableCell className="text-muted-foreground">{l.lineNumber ?? i + 1}</TableCell>
                <TableCell className="font-mono text-sm">{l.itemCode ?? "—"}</TableCell>
                <TableCell className="text-sm">{l.description ?? l.itemName ?? "—"}</TableCell>
                <TableCell className="text-right">{l.quantity}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{l.unitOfMeasure ?? ""}</TableCell>
                <TableCell className="text-right">{fmtCurrency(l.estimatedUnitPrice)}</TableCell>
                <TableCell className="text-right font-medium">{fmtCurrency(Number(l.quantity ?? 0) * Number(l.estimatedUnitPrice ?? 0))}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {(req.approvalDecisions ?? []).length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Approval History</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {(req.approvalDecisions ?? []).map((d) => (
              <div key={d.id} className="flex items-start justify-between rounded-lg border p-3">
                <div>
                  <p className="text-sm font-medium">{d.approverEmail ?? "—"}</p>
                  {d.comment && <p className="text-xs text-muted-foreground mt-1">{d.comment}</p>}
                </div>
                <div className="text-right">
                  <StatusBadge status={d.decision} />
                  <p className="text-xs text-muted-foreground mt-1">{fmtDateTime(d.createdAt)}</p>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {showEdit && (
        <RequisitionEditDialog id={id} req={req} open onClose={() => setShowEdit(false)} onSaved={inv} />
      )}
      {decisionDialog && (
        <DecisionDialog
          open
          title={decisionDialog.action === "approved" ? "Approve Requisition" : decisionDialog.action === "rejected" ? "Reject Requisition" : "Return Requisition"}
          onClose={() => setDecisionDialog(null)}
          onConfirm={async (comment) => {
            await decisionMut.mutateAsync({ id, data: { decision: decisionDialog.action, comment } });
            toast({ title: `Requisition ${decisionDialog.action}` });
            inv();
            setDecisionDialog(null);
          }}
          isPending={decisionMut.isPending}
        />
      )}
    </div>
  );
}

type ReqFormValues = {
  title: string; description: string; priority: string; currencyCode: string;
  requiredByDate: string; notes: string; preferredSupplierId: string;
  deliverToWarehouseId: string; lines: RequisitionLineInput[];
};

function RequisitionCreateDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const createMut = useCreateRequisition();
  const { data: suppliersData } = useListSuppliers({});
  const { data: warehousesData } = useListWarehouses({});
  const suppliers = (suppliersData as { suppliers?: { id: number; name: string }[] })?.suppliers ?? [];
  const warehouses = (warehousesData as { warehouses?: { id: number; name: string }[] })?.warehouses ?? [];

  const { register, handleSubmit, control, reset, formState: { errors } } = useForm<ReqFormValues>({
    defaultValues: { title: "", description: "", priority: "normal", currencyCode: "AUD", requiredByDate: "", notes: "", preferredSupplierId: "__none__", deliverToWarehouseId: "__none__", lines: [] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });

  useEffect(() => { if (!open) reset(); }, [open, reset]);

  const onSubmit = async (values: ReqFormValues) => {
    await createMut.mutateAsync({
      data: {
        title: values.title,
        description: values.description || undefined,
        priority: values.priority as "low" | "normal" | "urgent",
        currencyCode: values.currencyCode,
        requiredByDate: values.requiredByDate || undefined,
        notes: values.notes || undefined,
        preferredSupplierId: values.preferredSupplierId !== "__none__" ? Number(values.preferredSupplierId) : undefined,
        deliverToWarehouseId: values.deliverToWarehouseId !== "__none__" ? Number(values.deliverToWarehouseId) : undefined,
        lines: values.lines.map((l, i) => ({
          ...l, lineNumber: i + 1,
          quantity: Number(l.quantity),
          estimatedUnitPrice: l.estimatedUnitPrice != null ? Number(l.estimatedUnitPrice) : undefined,
        })),
      },
    });
    toast({ title: "Requisition created" });
    onSaved();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Purchase Requisition</DialogTitle>
          <DialogDescription>Create a requisition for internal approval before ordering</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <FormField label="Title" required>
                <Input {...register("title", { required: true })} placeholder="e.g. Office supplies Q3" />
                {errors.title && <p className="text-xs text-destructive mt-1">Required</p>}
              </FormField>
            </div>
            <FormField label="Priority">
              <Controller name="priority" control={control} render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              )} />
            </FormField>
            <FormField label="Required By">
              <Input type="date" {...register("requiredByDate")} />
            </FormField>
            <FormField label="Preferred Supplier">
              <Controller name="preferredSupplierId" control={control} render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue placeholder="— None —" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— None —</SelectItem>
                    {suppliers.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )} />
            </FormField>
            <FormField label="Deliver to Warehouse">
              <Controller name="deliverToWarehouseId" control={control} render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue placeholder="— None —" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— None —</SelectItem>
                    {warehouses.map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )} />
            </FormField>
            <div className="col-span-2">
              <FormField label="Notes"><Textarea {...register("notes")} rows={2} /></FormField>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Lines</Label>
              <Button type="button" size="sm" variant="outline" onClick={() => append({ lineNumber: fields.length + 1, itemCode: "", itemName: "", description: "", quantity: 1, unitOfMeasure: "EA" } as RequisitionLineInput)}>
                <Plus className="mr-1 h-3 w-3" />Add Line
              </Button>
            </div>
            {fields.length > 0 && (
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item Code</TableHead><TableHead>Description</TableHead>
                      <TableHead>Qty</TableHead><TableHead>UoM</TableHead><TableHead>Est. Price</TableHead>
                      <TableHead className="w-8"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((f, idx) => (
                      <TableRow key={f.id}>
                        <TableCell><Input {...register(`lines.${idx}.itemCode`)} className="h-7 text-xs" /></TableCell>
                        <TableCell><Input {...register(`lines.${idx}.description`)} className="h-7 text-xs" /></TableCell>
                        <TableCell><Input type="number" {...register(`lines.${idx}.quantity`)} className="h-7 text-xs w-16" /></TableCell>
                        <TableCell><Input {...register(`lines.${idx}.unitOfMeasure`)} className="h-7 text-xs w-14" /></TableCell>
                        <TableCell><Input type="number" step="0.01" {...register(`lines.${idx}.estimatedUnitPrice`)} className="h-7 text-xs w-24" /></TableCell>
                        <TableCell>
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(idx)}><Trash2 className="h-3 w-3" /></Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={createMut.isPending}>
              {createMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create Requisition
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RequisitionEditDialog({ id, req, open, onClose, onSaved }: { id: number; req: PurchaseRequisition; open: boolean; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const updateMut = useUpdateRequisition();
  const { register, handleSubmit } = useForm({ defaultValues: { title: req.title ?? "", notes: req.notes ?? "" } });

  const onSubmit = async (values: { title: string; notes: string }) => {
    await updateMut.mutateAsync({ id, data: { title: values.title, notes: values.notes || undefined } });
    toast({ title: "Requisition updated" });
    onSaved();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit Requisition</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <FormField label="Title" required><Input {...register("title", { required: true })} /></FormField>
          <FormField label="Notes"><Textarea {...register("notes")} rows={3} /></FormField>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={updateMut.isPending}>
              {updateMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Purchase Orders ──────────────────────────────────────────────────────────

type PoDetail = PurchaseOrder & {
  lines?: (PoLineInput & { id?: number; lineNumber?: number; receivedQty?: string | number; lineTotal?: string | number })[];
  receipts?: PoReceipt[];
  approvalDecisions?: { id: number; decision: string; approverEmail?: string; comment?: string; createdAt: string }[];
};

function PurchaseOrdersTab() {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState("__all__");
  const [q, setQ] = useState("");
  const [decisionDialog, setDecisionDialog] = useState<{ id: number; action: "approved" | "rejected" | "returned" } | null>(null);

  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useListPurchaseOrders({ status: statusFilter === "__all__" ? undefined : statusFilter, q: q || undefined });
  const { data: detail } = useGetPurchaseOrder(selectedId!, { query: { enabled: selectedId != null, queryKey: getGetPurchaseOrderQueryKey(selectedId!) } });

  const pos: PurchaseOrder[] = (data as { purchaseOrders?: PurchaseOrder[] })?.purchaseOrders ?? [];

  const deleteMut = useDeletePurchaseOrder();
  const submitMut = useSubmitPurchaseOrder();
  const decisionMut = useDecidePurchaseOrder();
  const sendMut = useSendPurchaseOrder();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
    if (selectedId) qc.invalidateQueries({ queryKey: getGetPurchaseOrderQueryKey(selectedId) });
  };

  if (selectedId != null) {
    return (
      <PurchaseOrderDetail
        id={selectedId}
        detail={detail}
        onBack={() => setSelectedId(null)}
        onRefresh={invalidate}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-2 flex-wrap">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search..." className="pl-8 w-48" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="pending_approval">Pending Approval</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="sent">Sent</SelectItem>
              <SelectItem value="partially_received">Partly Received</SelectItem>
              <SelectItem value="received">Received</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setShowCreate(true)}><Plus className="mr-2 h-4 w-4" />New Purchase Order</Button>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead><TableHead>Supplier</TableHead><TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead><TableHead>Delivery</TableHead><TableHead>Created</TableHead>
              <TableHead className="w-10"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}><TableCell colSpan={7}><Skeleton className="h-5" /></TableCell></TableRow>
              ))
            ) : pos.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">No purchase orders found</TableCell></TableRow>
            ) : pos.map((po) => (
              <TableRow key={po.id} className="cursor-pointer hover:bg-muted/50" onClick={() => setSelectedId(po.id!)}>
                <TableCell className="font-mono text-sm font-medium">{po.code}</TableCell>
                <TableCell>{po.supplierName ?? "—"}</TableCell>
                <TableCell><StatusBadge status={po.status} /></TableCell>
                <TableCell className="text-right font-medium">{fmtCurrency(po.total, po.currencyCode ?? "AUD")}</TableCell>
                <TableCell>{fmtDate(po.deliveryDate)}</TableCell>
                <TableCell>{fmtDate(po.createdAt)}</TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setSelectedId(po.id!)}><Pencil className="mr-2 h-4 w-4" />Open</DropdownMenuItem>
                      {po.status === "draft" && (
                        <DropdownMenuItem onClick={() => submitMut.mutateAsync({ id: po.id! }).then(() => { toast({ title: "Submitted" }); invalidate(); })} disabled={submitMut.isPending}>
                          <Send className="mr-2 h-4 w-4" />Submit for Approval
                        </DropdownMenuItem>
                      )}
                      {po.status === "pending_approval" && (
                        <>
                          <DropdownMenuItem onClick={() => setDecisionDialog({ id: po.id!, action: "approved" })}><CheckCircle2 className="mr-2 h-4 w-4" />Approve</DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setDecisionDialog({ id: po.id!, action: "rejected" })}><XCircle className="mr-2 h-4 w-4" />Reject</DropdownMenuItem>
                        </>
                      )}
                      {po.status === "approved" && (
                        <DropdownMenuItem onClick={() => sendMut.mutateAsync({ id: po.id! }).then(() => { toast({ title: "PO marked as sent" }); invalidate(); })} disabled={sendMut.isPending}>
                          <Send className="mr-2 h-4 w-4" />Mark as Sent
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive" onClick={() => { if (confirm("Delete this purchase order?")) deleteMut.mutateAsync({ id: po.id! }).then(() => { toast({ title: "Deleted" }); invalidate(); }); }}>
                        <Trash2 className="mr-2 h-4 w-4" />Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <PoCreateDialog open={showCreate} onClose={() => setShowCreate(false)} onSaved={invalidate} />

      {decisionDialog && (
        <DecisionDialog
          open
          title={decisionDialog.action === "approved" ? "Approve Purchase Order" : "Reject Purchase Order"}
          onClose={() => setDecisionDialog(null)}
          onConfirm={async (comment) => {
            await decisionMut.mutateAsync({ id: decisionDialog.id, data: { decision: decisionDialog.action, comment } });
            toast({ title: `Purchase order ${decisionDialog.action}` });
            invalidate();
            setDecisionDialog(null);
          }}
          isPending={decisionMut.isPending}
        />
      )}
    </div>
  );
}

function PurchaseOrderDetail({ id, detail, onBack, onRefresh }: { id: number; detail: unknown; onBack: () => void; onRefresh: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [decisionDialog, setDecisionDialog] = useState<{ action: "approved" | "rejected" | "returned" } | null>(null);
  const [showReceive, setShowReceive] = useState(false);

  const submitMut = useSubmitPurchaseOrder();
  const decisionMut = useDecidePurchaseOrder();
  const sendMut = useSendPurchaseOrder();
  const pdfMut = useGeneratePurchaseOrderPdf();
  const po = detail as PoDetail | undefined;

  const handleDownloadPdf = () => {
    if (!po?.id) return;
    pdfMut.mutateAsync({ id: po.id, data: {} }).then((res) => {
      const typed = res as { pdfBase64?: string; filename?: string };
      if (typed.pdfBase64 && typed.filename) {
        const link = document.createElement("a");
        link.href = `data:application/pdf;base64,${typed.pdfBase64}`;
        link.download = typed.filename;
        link.click();
      }
      toast({ title: "PDF generated" });
    }).catch(() => toast({ title: "PDF generation failed", variant: "destructive" }));
  };

  const inv = () => {
    qc.invalidateQueries({ queryKey: getGetPurchaseOrderQueryKey(id) });
    onRefresh();
  };

  if (!po) return <Skeleton className="h-96" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="sm" onClick={onBack}><ArrowLeft className="h-4 w-4 mr-1" />Back</Button>
        <div className="flex-1">
          <h3 className="text-xl font-bold">{po.code}</h3>
          <p className="text-muted-foreground text-sm">{po.supplierName ?? "No supplier"}</p>
        </div>
        <StatusBadge status={po.status} />
        <div className="flex gap-2 flex-wrap">
          {po.status === "draft" && (
            <Button size="sm" onClick={() => submitMut.mutateAsync({ id }).then(() => { toast({ title: "Submitted" }); inv(); })} disabled={submitMut.isPending}>
              {submitMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}<Send className="mr-2 h-4 w-4" />Submit
            </Button>
          )}
          {po.status === "pending_approval" && (
            <>
              <Button size="sm" variant="outline" className="text-green-700" onClick={() => setDecisionDialog({ action: "approved" })}><CheckCircle2 className="mr-2 h-4 w-4" />Approve</Button>
              <Button size="sm" variant="outline" className="text-destructive" onClick={() => setDecisionDialog({ action: "rejected" })}><XCircle className="mr-2 h-4 w-4" />Reject</Button>
            </>
          )}
          {["draft", "approved", "sent", "pending_approval", "partially_received"].includes(po.status ?? "") && (
            <Button size="sm" variant="outline" onClick={handleDownloadPdf} disabled={pdfMut.isPending}>
              {pdfMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}<FileText className="mr-2 h-4 w-4" />Generate PDF
            </Button>
          )}
          {po.status === "approved" && (
            <Button size="sm" variant="outline" onClick={() => sendMut.mutateAsync({ id }).then(() => { toast({ title: "Marked as sent" }); inv(); })} disabled={sendMut.isPending}>
              <Send className="mr-2 h-4 w-4" />Mark Sent
            </Button>
          )}
          {["sent", "approved", "partially_received"].includes(po.status ?? "") && (
            <Button size="sm" onClick={() => setShowReceive(true)}><ClipboardCheck className="mr-2 h-4 w-4" />Receive Goods</Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Subtotal</p><p className="font-bold text-lg">{fmtCurrency(po.subtotal, po.currencyCode ?? "AUD")}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Tax</p><p className="font-bold text-lg">{fmtCurrency(po.taxAmount, po.currencyCode ?? "AUD")}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Total</p><p className="font-bold text-xl text-primary">{fmtCurrency(po.total, po.currencyCode ?? "AUD")}</p></CardContent></Card>
        <Card><CardContent className="pt-4"><p className="text-xs text-muted-foreground">Delivery Date</p><p className="font-medium">{fmtDate(po.deliveryDate)}</p></CardContent></Card>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-sm">Order Lines</CardTitle></CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead><TableHead>Item</TableHead><TableHead>Description</TableHead>
              <TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Rcvd</TableHead>
              <TableHead className="text-right">Unit Price</TableHead><TableHead className="text-right">Line Total</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(po.lines ?? []).length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center py-6 text-muted-foreground">No lines</TableCell></TableRow>
            ) : (po.lines ?? []).map((l, i) => (
              <TableRow key={i}>
                <TableCell className="text-muted-foreground">{l.lineNumber ?? i + 1}</TableCell>
                <TableCell className="font-mono text-sm">{l.itemCode ?? "—"}</TableCell>
                <TableCell className="text-sm">{l.description ?? "—"}</TableCell>
                <TableCell className="text-right">{fmtNum(l.quantity)}</TableCell>
                <TableCell className="text-right">{fmtNum(l.receivedQty ?? 0)}</TableCell>
                <TableCell className="text-right">{fmtCurrency(l.unitPrice)}</TableCell>
                <TableCell className="text-right font-medium">{fmtCurrency(l.lineTotal)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {(po.receipts ?? []).length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Receipts</CardTitle></CardHeader>
          <Table>
            <TableHeader><TableRow><TableHead>Code</TableHead><TableHead>Status</TableHead><TableHead>Received At</TableHead><TableHead>Delivery Ref</TableHead></TableRow></TableHeader>
            <TableBody>
              {(po.receipts ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-sm">{r.code}</TableCell>
                  <TableCell><StatusBadge status={r.status} /></TableCell>
                  <TableCell>{fmtDateTime(r.receivedAt)}</TableCell>
                  <TableCell>{r.supplierDeliveryRef ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {showReceive && (
        <ReceiptCreateDialog
          open
          poId={id}
          poLines={po.lines ?? []}
          onClose={() => setShowReceive(false)}
          onSaved={() => { qc.invalidateQueries({ queryKey: getListReceiptsQueryKey() }); inv(); }}
        />
      )}

      {decisionDialog && (
        <DecisionDialog
          open
          title={decisionDialog.action === "approved" ? "Approve PO" : decisionDialog.action === "rejected" ? "Reject PO" : "Return PO"}
          onClose={() => setDecisionDialog(null)}
          onConfirm={async (comment) => {
            await decisionMut.mutateAsync({ id, data: { decision: decisionDialog.action, comment } });
            toast({ title: `PO ${decisionDialog.action}` });
            inv();
            setDecisionDialog(null);
          }}
          isPending={decisionMut.isPending}
        />
      )}
    </div>
  );
}

type PoFormValues = {
  supplierId: string; deliverToWarehouseId: string; deliveryDate: string;
  currencyCode: string; paymentTerms: string; notes: string;
  lines: PoLineInput[];
};

function PoCreateDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const createMut = useCreatePurchaseOrder();
  const { data: suppliersData } = useListSuppliers({});
  const { data: warehousesData } = useListWarehouses({});
  const suppliers = (suppliersData as { suppliers?: { id: number; name: string }[] })?.suppliers ?? [];
  const warehouses = (warehousesData as { warehouses?: { id: number; name: string }[] })?.warehouses ?? [];

  const { register, handleSubmit, control, reset } = useForm<PoFormValues>({
    defaultValues: { supplierId: "__none__", deliverToWarehouseId: "__none__", deliveryDate: "", currencyCode: "AUD", paymentTerms: "Net30", notes: "", lines: [] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });

  useEffect(() => { if (!open) reset(); }, [open, reset]);

  const onSubmit = async (values: PoFormValues) => {
    await createMut.mutateAsync({
      data: {
        supplierId: values.supplierId !== "__none__" ? Number(values.supplierId) : undefined,
        deliverToWarehouseId: values.deliverToWarehouseId !== "__none__" ? Number(values.deliverToWarehouseId) : undefined,
        deliveryDate: values.deliveryDate || undefined,
        currencyCode: values.currencyCode,
        paymentTerms: values.paymentTerms || undefined,
        notes: values.notes || undefined,
        lines: values.lines.map((l, i) => ({
          ...l, lineNumber: i + 1,
          quantity: Number(l.quantity ?? 0),
          unitPrice: Number(l.unitPrice ?? 0),
          discountPct: Number(l.discountPct ?? 0),
          taxPct: Number(l.taxPct ?? 0),
          lineType: (l.lineType ?? "stock") as "stock" | "service" | "charge" | "comment",
        })),
      },
    });
    toast({ title: "Purchase order created" });
    onSaved();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Purchase Order</DialogTitle>
          <DialogDescription>Create a purchase order to send to a supplier</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Supplier">
              <Controller name="supplierId" control={control} render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue placeholder="— select —" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— None —</SelectItem>
                    {suppliers.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )} />
            </FormField>
            <FormField label="Deliver to Warehouse">
              <Controller name="deliverToWarehouseId" control={control} render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue placeholder="— select —" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— None —</SelectItem>
                    {warehouses.map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )} />
            </FormField>
            <FormField label="Delivery Date"><Input type="date" {...register("deliveryDate")} /></FormField>
            <FormField label="Currency"><Input {...register("currencyCode")} /></FormField>
            <FormField label="Payment Terms"><Input {...register("paymentTerms")} /></FormField>
            <FormField label="Notes"><Input {...register("notes")} /></FormField>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Lines</Label>
              <Button type="button" size="sm" variant="outline" onClick={() => append({ lineNumber: fields.length + 1, lineType: "stock", itemCode: "", description: "", quantity: 1, unitPrice: 0, discountPct: 0, taxPct: 0 } as PoLineInput)}>
                <Plus className="mr-1 h-3 w-3" />Add Line
              </Button>
            </div>
            {fields.length > 0 && (
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead><TableHead>Item Code</TableHead><TableHead>Description</TableHead>
                      <TableHead>Qty</TableHead><TableHead>Unit Price</TableHead><TableHead>Disc%</TableHead><TableHead>Tax%</TableHead>
                      <TableHead className="w-8"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((f, idx) => (
                      <TableRow key={f.id}>
                        <TableCell>
                          <Controller name={`lines.${idx}.lineType`} control={control} render={({ field }) => (
                            <Select value={field.value as string ?? "stock"} onValueChange={field.onChange}>
                              <SelectTrigger className="h-7 text-xs w-20"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="stock">Stock</SelectItem>
                                <SelectItem value="service">Service</SelectItem>
                                <SelectItem value="charge">Charge</SelectItem>
                              </SelectContent>
                            </Select>
                          )} />
                        </TableCell>
                        <TableCell><Input {...register(`lines.${idx}.itemCode`)} className="h-7 text-xs w-24" /></TableCell>
                        <TableCell><Input {...register(`lines.${idx}.description`)} className="h-7 text-xs" /></TableCell>
                        <TableCell><Input type="number" {...register(`lines.${idx}.quantity`)} className="h-7 text-xs w-14" /></TableCell>
                        <TableCell><Input type="number" step="0.01" {...register(`lines.${idx}.unitPrice`)} className="h-7 text-xs w-20" /></TableCell>
                        <TableCell><Input type="number" {...register(`lines.${idx}.discountPct`)} className="h-7 text-xs w-14" /></TableCell>
                        <TableCell><Input type="number" {...register(`lines.${idx}.taxPct`)} className="h-7 text-xs w-14" /></TableCell>
                        <TableCell>
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(idx)}><Trash2 className="h-3 w-3" /></Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={createMut.isPending}>
              {createMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create PO
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Goods Receipts ───────────────────────────────────────────────────────────

function ReceiptsTab() {
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState("__all__");
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading } = useListReceipts({ status: statusFilter === "__all__" ? undefined : statusFilter });
  const receipts: PoReceipt[] = (data as { receipts?: PoReceipt[] })?.receipts ?? [];
  const confirmMut = useConfirmReceipt();

  const invalidate = () => qc.invalidateQueries({ queryKey: getListReceiptsQueryKey() });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="confirmed">Confirmed</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => setShowCreate(true)}><Plus className="mr-2 h-4 w-4" />New Receipt</Button>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead><TableHead>PO ID</TableHead><TableHead>Status</TableHead>
              <TableHead>Delivery Ref</TableHead><TableHead>Received At</TableHead><TableHead className="w-28"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => <TableRow key={i}><TableCell colSpan={6}><Skeleton className="h-5" /></TableCell></TableRow>)
            ) : receipts.length === 0 ? (
              <TableRow><TableCell colSpan={6} className="text-center py-10 text-muted-foreground">No receipts found</TableCell></TableRow>
            ) : receipts.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-sm font-medium">{r.code}</TableCell>
                <TableCell>{r.poId}</TableCell>
                <TableCell><StatusBadge status={r.status} /></TableCell>
                <TableCell>{r.supplierDeliveryRef ?? "—"}</TableCell>
                <TableCell>{fmtDateTime(r.receivedAt)}</TableCell>
                <TableCell>
                  {r.status === "draft" && (
                    <Button size="sm" variant="outline" onClick={() => confirmMut.mutateAsync({ id: r.id! }).then(() => { toast({ title: "Receipt confirmed — inventory updated" }); invalidate(); })} disabled={confirmMut.isPending}>
                      {confirmMut.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Confirm
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {showCreate && (
        <ReceiptCreateDialog open poId={undefined} poLines={[]} onClose={() => setShowCreate(false)} onSaved={invalidate} />
      )}
    </div>
  );
}

type RcvLine = { poLineId: number; itemCode: string; orderedQty: number; receivedQty: number; unitCost: number; lotNumber: string; serialNumber: string; batchNumber: string };
type RcvForm = { poId: string; warehouseId: string; supplierDeliveryRef: string; notes: string; andConfirm: boolean; lines: RcvLine[] };

function ReceiptCreateDialog({ open, poId, poLines, onClose, onSaved }: {
  open: boolean; poId?: number;
  poLines: (PoLineInput & { id?: number; lineNumber?: number; quantity?: string | number; itemCode?: string })[];
  onClose: () => void; onSaved: () => void;
}) {
  const { toast } = useToast();
  const createMut = useCreateReceipt();
  const confirmMut = useConfirmReceipt();
  const { data: warehousesData } = useListWarehouses({});
  const warehouses = (warehousesData as { warehouses?: { id: number; name: string }[] })?.warehouses ?? [];

  const { register, handleSubmit, control, reset, watch } = useForm<RcvForm>({
    defaultValues: {
      poId: poId ? String(poId) : "",
      warehouseId: "__none__",
      supplierDeliveryRef: "",
      notes: "",
      andConfirm: false,
      lines: poLines.map((l) => ({
        poLineId: l.id ?? 0,
        itemCode: l.itemCode ?? "",
        orderedQty: Number(l.quantity ?? 0),
        receivedQty: Number(l.quantity ?? 0),
        unitCost: 0,
        lotNumber: "",
        serialNumber: "",
        batchNumber: "",
      })),
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });

  useEffect(() => { if (!open) reset(); }, [open, reset]);

  const onSubmit = async (values: RcvForm) => {
    const receipt = await createMut.mutateAsync({
      data: {
        poId: Number(values.poId),
        warehouseId: values.warehouseId !== "__none__" ? Number(values.warehouseId) : undefined,
        supplierDeliveryRef: values.supplierDeliveryRef || undefined,
        notes: values.notes || undefined,
        lines: values.lines.map((l) => ({
          poLineId: Number(l.poLineId),
          orderedQty: Number(l.orderedQty),
          receivedQty: Number(l.receivedQty),
          unitCost: Number(l.unitCost) || undefined,
          lotNumber: l.lotNumber || undefined,
          serialNumber: l.serialNumber || undefined,
          batchNumber: l.batchNumber || undefined,
        })),
      },
    });
    if (values.andConfirm) {
      await confirmMut.mutateAsync({ id: (receipt as PoReceipt).id! });
      toast({ title: "Receipt confirmed — inventory and GL updated" });
    } else {
      toast({ title: "Receipt created as draft" });
    }
    onSaved();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Goods Receipt</DialogTitle>
          <DialogDescription>Record goods received with lot/serial/batch capture</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FormField label="PO ID" required>
              <Input type="number" {...register("poId", { required: true })} placeholder="Enter PO ID" />
            </FormField>
            <FormField label="Warehouse">
              <Controller name="warehouseId" control={control} render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue placeholder="— select —" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— None —</SelectItem>
                    {warehouses.map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )} />
            </FormField>
            <FormField label="Supplier Delivery Ref">
              <Input {...register("supplierDeliveryRef")} placeholder="Supplier's delivery note" />
            </FormField>
            <FormField label="Notes"><Input {...register("notes")} /></FormField>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Receipt Lines</Label>
              <Button type="button" size="sm" variant="outline" onClick={() => append({ poLineId: 0, itemCode: "", orderedQty: 0, receivedQty: 0, unitCost: 0, lotNumber: "", serialNumber: "", batchNumber: "" })}>
                <Plus className="mr-1 h-3 w-3" />Add Line
              </Button>
            </div>
            {fields.length > 0 && (
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>PO Line ID</TableHead><TableHead>Item</TableHead>
                      <TableHead>Ordered</TableHead><TableHead>Received</TableHead>
                      <TableHead>Unit Cost</TableHead><TableHead>Lot #</TableHead>
                      <TableHead>Serial #</TableHead><TableHead>Batch #</TableHead>
                      <TableHead className="w-8"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((f, idx) => (
                      <TableRow key={f.id}>
                        <TableCell><Input type="number" {...register(`lines.${idx}.poLineId`)} className="h-7 text-xs w-16" /></TableCell>
                        <TableCell><Input {...register(`lines.${idx}.itemCode`)} className="h-7 text-xs w-20" /></TableCell>
                        <TableCell><Input type="number" {...register(`lines.${idx}.orderedQty`)} className="h-7 text-xs w-16" /></TableCell>
                        <TableCell><Input type="number" {...register(`lines.${idx}.receivedQty`)} className="h-7 text-xs w-16" /></TableCell>
                        <TableCell><Input type="number" step="0.01" {...register(`lines.${idx}.unitCost`)} className="h-7 text-xs w-20" /></TableCell>
                        <TableCell><Input {...register(`lines.${idx}.lotNumber`)} className="h-7 text-xs w-20" /></TableCell>
                        <TableCell><Input {...register(`lines.${idx}.serialNumber`)} className="h-7 text-xs w-20" /></TableCell>
                        <TableCell><Input {...register(`lines.${idx}.batchNumber`)} className="h-7 text-xs w-20" /></TableCell>
                        <TableCell>
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(idx)}><Trash2 className="h-3 w-3" /></Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 rounded-lg border p-3 bg-muted/30">
            <input type="checkbox" id="andConfirm" {...register("andConfirm")} className="h-4 w-4 rounded border-input" />
            <Label htmlFor="andConfirm" className="font-normal cursor-pointer text-sm">
              Confirm immediately — posts inventory movements and GL entries (Dr Inventory / Cr AP)
            </Label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={createMut.isPending || confirmMut.isPending}>
              {(createMut.isPending || confirmMut.isPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {watch("andConfirm") ? "Create & Confirm" : "Create Draft"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Returns to Vendor ────────────────────────────────────────────────────────

function ReturnsTab() {
  const [showCreate, setShowCreate] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListReturns({});
  const returns: PoReturn[] = (data as { returns?: PoReturn[] })?.returns ?? [];
  const confirmMut = useConfirmReturn();

  const invalidate = () => qc.invalidateQueries({ queryKey: getListReturnsQueryKey() });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowCreate(true)}><Plus className="mr-2 h-4 w-4" />New Return</Button>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead><TableHead>PO ID</TableHead><TableHead>Type</TableHead>
              <TableHead>Status</TableHead><TableHead>Reason</TableHead>
              <TableHead className="text-right">Total</TableHead><TableHead className="w-24"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => <TableRow key={i}><TableCell colSpan={7}><Skeleton className="h-5" /></TableCell></TableRow>)
            ) : returns.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">No returns found</TableCell></TableRow>
            ) : returns.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-sm font-medium">{r.code}</TableCell>
                <TableCell>{r.poId}</TableCell>
                <TableCell><Badge variant="outline">{r.returnType}</Badge></TableCell>
                <TableCell><StatusBadge status={r.status} /></TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.reason ?? "—"}</TableCell>
                <TableCell className="text-right font-medium">{fmtCurrency(r.total)}</TableCell>
                <TableCell>
                  {r.status === "draft" && (
                    <Button size="sm" variant="outline" onClick={() => confirmMut.mutateAsync({ id: r.id! }).then(() => { toast({ title: "Return confirmed — inventory reversed" }); invalidate(); })} disabled={confirmMut.isPending}>
                      {confirmMut.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Confirm
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      {showCreate && <ReturnCreateDialog open onClose={() => setShowCreate(false)} onSaved={invalidate} />}
    </div>
  );
}

type RtLine = { itemCode: string; quantity: number; unitCost: number; lotNumber: string; serialNumber: string; reason: string };
type RtForm = { poId: string; warehouseId: string; returnType: string; reason: string; notes: string; lines: RtLine[] };

function ReturnCreateDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const createMut = useCreateReturn();
  const { data: warehousesData } = useListWarehouses({});
  const warehouses = (warehousesData as { warehouses?: { id: number; name: string }[] })?.warehouses ?? [];

  const { register, handleSubmit, control, reset } = useForm<RtForm>({
    defaultValues: { poId: "", warehouseId: "__none__", returnType: "credit", reason: "", notes: "", lines: [] },
  });
  const { fields, append, remove } = useFieldArray({ control, name: "lines" });

  useEffect(() => { if (!open) reset(); }, [open, reset]);

  const onSubmit = async (values: RtForm) => {
    await createMut.mutateAsync({
      data: {
        poId: Number(values.poId),
        warehouseId: values.warehouseId !== "__none__" ? Number(values.warehouseId) : undefined,
        returnType: values.returnType as "credit" | "replace",
        reason: values.reason || undefined,
        notes: values.notes || undefined,
        lines: values.lines.map((l) => ({
          itemCode: l.itemCode || undefined,
          quantity: Number(l.quantity),
          unitCost: Number(l.unitCost) || undefined,
          lotNumber: l.lotNumber || undefined,
          serialNumber: l.serialNumber || undefined,
          reason: l.reason || undefined,
        })),
      },
    });
    toast({ title: "Return to vendor created" });
    onSaved();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New Return to Vendor</DialogTitle>
          <DialogDescription>Record items being returned to the supplier</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FormField label="PO ID" required><Input type="number" {...register("poId", { required: true })} /></FormField>
            <FormField label="Return Type">
              <Controller name="returnType" control={control} render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="credit">Credit Note</SelectItem>
                    <SelectItem value="replace">Replacement</SelectItem>
                  </SelectContent>
                </Select>
              )} />
            </FormField>
            <FormField label="Warehouse">
              <Controller name="warehouseId" control={control} render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue placeholder="— select —" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— None —</SelectItem>
                    {warehouses.map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )} />
            </FormField>
            <FormField label="Reason"><Input {...register("reason")} /></FormField>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Return Lines</Label>
              <Button type="button" size="sm" variant="outline" onClick={() => append({ itemCode: "", quantity: 1, unitCost: 0, lotNumber: "", serialNumber: "", reason: "" })}>
                <Plus className="mr-1 h-3 w-3" />Add Line
              </Button>
            </div>
            {fields.length > 0 && (
              <div className="rounded-md border overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item Code</TableHead><TableHead>Qty</TableHead><TableHead>Unit Cost</TableHead>
                      <TableHead>Lot #</TableHead><TableHead>Serial #</TableHead><TableHead>Reason</TableHead>
                      <TableHead className="w-8"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((f, idx) => (
                      <TableRow key={f.id}>
                        <TableCell><Input {...register(`lines.${idx}.itemCode`)} className="h-7 text-xs" /></TableCell>
                        <TableCell><Input type="number" {...register(`lines.${idx}.quantity`)} className="h-7 text-xs w-14" /></TableCell>
                        <TableCell><Input type="number" step="0.01" {...register(`lines.${idx}.unitCost`)} className="h-7 text-xs w-20" /></TableCell>
                        <TableCell><Input {...register(`lines.${idx}.lotNumber`)} className="h-7 text-xs w-20" /></TableCell>
                        <TableCell><Input {...register(`lines.${idx}.serialNumber`)} className="h-7 text-xs w-20" /></TableCell>
                        <TableCell><Input {...register(`lines.${idx}.reason`)} className="h-7 text-xs" /></TableCell>
                        <TableCell>
                          <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => remove(idx)}><Trash2 className="h-3 w-3" /></Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={createMut.isPending}>
              {createMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create Return
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Inventory Stock ──────────────────────────────────────────────────────────

function InventoryTab() {
  const [q, setQ] = useState("");
  const { data, isLoading } = useListInventoryStock({});
  type StockRow = {
    id: number; itemCode?: string; itemName?: string; warehouseName?: string;
    lotNumber?: string; batchNumber?: string; serialNumber?: string;
    qtyOnHand: string; qtyReserved: string; averageCost?: string; lastMovementAt?: string;
  };
  const stock: StockRow[] = ((data as { stock?: StockRow[] })?.stock ?? []).filter((r) => {
    if (!q) return true;
    const lq = q.toLowerCase();
    return (r.itemCode ?? "").toLowerCase().includes(lq)
      || (r.itemName ?? "").toLowerCase().includes(lq)
      || (r.warehouseName ?? "").toLowerCase().includes(lq);
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Filter by item or warehouse..." className="pl-8 w-64" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <p className="text-sm text-muted-foreground">{stock.length} record{stock.length !== 1 ? "s" : ""}</p>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item Code</TableHead><TableHead>Item Name</TableHead><TableHead>Warehouse</TableHead>
              <TableHead>Lot / Batch / Serial</TableHead>
              <TableHead className="text-right">On Hand</TableHead><TableHead className="text-right">Reserved</TableHead>
              <TableHead className="text-right">Avg Cost</TableHead><TableHead>Last Movement</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => <TableRow key={i}><TableCell colSpan={8}><Skeleton className="h-5" /></TableCell></TableRow>)
            ) : stock.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-10 text-muted-foreground">
                  No stock records. Confirm a goods receipt to post inventory.
                </TableCell>
              </TableRow>
            ) : stock.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="font-mono text-sm">{s.itemCode ?? "—"}</TableCell>
                <TableCell>{s.itemName ?? "—"}</TableCell>
                <TableCell>{s.warehouseName ?? "—"}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {[s.lotNumber && `Lot: ${s.lotNumber}`, s.batchNumber && `Batch: ${s.batchNumber}`, s.serialNumber && `S/N: ${s.serialNumber}`].filter(Boolean).join(" · ") || "—"}
                </TableCell>
                <TableCell className="text-right font-medium">{fmtNum(s.qtyOnHand, 4)}</TableCell>
                <TableCell className="text-right">{fmtNum(s.qtyReserved, 4)}</TableCell>
                <TableCell className="text-right">{fmtCurrency(s.averageCost)}</TableCell>
                <TableCell className="text-xs">{fmtDate(s.lastMovementAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      <p className="text-xs text-muted-foreground">
        Inventory reflects confirmed goods receipts only. Always verify with your warehouse team for real-time accuracy.
      </p>
    </div>
  );
}

// ─── GL Postings ──────────────────────────────────────────────────────────────

function GlPostingsTab() {
  const { data, isLoading } = useListGlPostings({});
  type GlRow = { id: number; code: string; entityType: string; entityId: number; status: string; postedByEmail?: string; postedAt?: string; totalDebit: string; totalCredit: string };
  const postings: GlRow[] = (data as { postings?: GlRow[] })?.postings ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead><TableHead>Entity</TableHead><TableHead>Status</TableHead>
              <TableHead className="text-right">Debit</TableHead><TableHead className="text-right">Credit</TableHead>
              <TableHead>Posted By</TableHead><TableHead>Posted At</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => <TableRow key={i}><TableCell colSpan={7}><Skeleton className="h-5" /></TableCell></TableRow>)
            ) : postings.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-10 text-muted-foreground">
                  No GL postings yet. Confirm a goods receipt to generate journal entries.
                </TableCell>
              </TableRow>
            ) : postings.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-mono text-sm">{p.code}</TableCell>
                <TableCell className="text-sm">
                  <Badge variant="outline">{p.entityType}</Badge>
                  <span className="ml-1 text-muted-foreground">#{p.entityId}</span>
                </TableCell>
                <TableCell><StatusBadge status={p.status} /></TableCell>
                <TableCell className="text-right font-medium">{fmtCurrency(p.totalDebit)}</TableCell>
                <TableCell className="text-right font-medium">{fmtCurrency(p.totalCredit)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{p.postedByEmail ?? "—"}</TableCell>
                <TableCell className="text-xs">{fmtDateTime(p.postedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}

// ─── Approval Workflows ───────────────────────────────────────────────────────

function WorkflowsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [selectedWf, setSelectedWf] = useState<number | null>(null);

  const { data, isLoading } = useListApprovalWorkflows();
  const workflows: ApprovalWorkflow[] = Array.isArray(data) ? (data as ApprovalWorkflow[]) : [];
  const createMut = useCreateApprovalWorkflow();
  const updateMut = useUpdateApprovalWorkflow();

  const invalidate = () => qc.invalidateQueries({ queryKey: getListApprovalWorkflowsQueryKey() });

  type WfForm = { name: string; description: string; entityType: string; isActive: boolean };
  const { register, handleSubmit, control, reset } = useForm<WfForm>({
    defaultValues: { name: "", description: "", entityType: "purchase_order", isActive: true },
  });

  const onSubmit = async (values: WfForm) => {
    await createMut.mutateAsync({
      data: {
        name: values.name,
        description: values.description || undefined,
        entityType: values.entityType as "purchase_requisition" | "purchase_order",
        isActive: values.isActive,
      },
    });
    toast({ title: "Workflow created" });
    invalidate();
    setShowCreate(false);
    reset();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Configure multi-level approval workflows for requisitions and purchase orders.</p>
        </div>
        <Button onClick={() => setShowCreate(true)}><Plus className="mr-2 h-4 w-4" />New Workflow</Button>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-32" />)}</div>
      ) : workflows.length === 0 ? (
        <EmptyState icon={Settings} title="No approval workflows" description="Create a workflow to route requisitions and POs through an approval chain." />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {workflows.map((wf) => (
            <Card
              key={wf.id}
              className={`cursor-pointer transition-colors ${selectedWf === wf.id ? "ring-2 ring-primary" : "hover:bg-muted/30"}`}
              onClick={() => setSelectedWf(selectedWf === wf.id ? null : wf.id!)}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{wf.name}</CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{wf.entityType?.replace(/_/g, " ")}</Badge>
                    <Badge variant={wf.isActive ? "default" : "secondary"} className={wf.isActive ? "bg-green-100 text-green-800" : ""}>
                      {wf.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{wf.description ?? "No description"}</p>
                <div className="mt-3">
                  <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); updateMut.mutateAsync({ id: wf.id!, data: { name: wf.name!, entityType: wf.entityType as "purchase_requisition" | "purchase_order", isActive: !wf.isActive } }).then(() => { toast({ title: "Updated" }); invalidate(); }); }}>
                    {wf.isActive ? "Deactivate" : "Activate"}
                  </Button>
                </div>
              </CardContent>
              {selectedWf === wf.id && <WorkflowStepsPanel workflowId={wf.id!} />}
            </Card>
          ))}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={(o) => !o && setShowCreate(false)}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Approval Workflow</DialogTitle><DialogDescription>Create an approval chain for POs or requisitions</DialogDescription></DialogHeader>
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            <FormField label="Name" required><Input {...register("name", { required: true })} /></FormField>
            <FormField label="Description"><Textarea {...register("description")} rows={2} /></FormField>
            <FormField label="Applies To">
              <Controller name="entityType" control={control} render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="purchase_order">Purchase Order</SelectItem>
                    <SelectItem value="purchase_requisition">Purchase Requisition</SelectItem>
                  </SelectContent>
                </Select>
              )} />
            </FormField>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setShowCreate(false); reset(); }}>Cancel</Button>
              <Button type="submit" disabled={createMut.isPending}>
                {createMut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WorkflowStepsPanel({ workflowId }: { workflowId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: stepsData, isLoading } = useListApprovalSteps(workflowId);
  type Step = { id: number; stepNumber: number; stepName: string; approvalMode: string; approverRoles?: string[] };
  const steps: Step[] = Array.isArray(stepsData) ? (stepsData as Step[]) : [];
  const createStep = useCreateApprovalStep();
  const deleteStep = useDeleteApprovalStep();
  const [showAddStep, setShowAddStep] = useState(false);

  const { register, handleSubmit, reset } = useForm({ defaultValues: { stepNumber: steps.length + 1, stepName: "", approverRole: "approver" } });

  const onAddStep = async (values: { stepNumber: number; stepName: string; approverRole: string }) => {
    await createStep.mutateAsync({ id: workflowId, data: { stepNumber: Number(values.stepNumber), stepName: values.stepName, approverType: "role", approverRoles: [values.approverRole] } });
    toast({ title: "Step added" });
    qc.invalidateQueries({ queryKey: getListApprovalStepsQueryKey(workflowId) });
    setShowAddStep(false);
    reset();
  };

  return (
    <CardContent className="border-t pt-4" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-medium">Approval Steps</p>
        <Button size="sm" variant="outline" onClick={() => setShowAddStep(!showAddStep)}><Plus className="mr-1 h-3 w-3" />Add Step</Button>
      </div>
      {isLoading ? <Skeleton className="h-12" /> : (
        <div className="space-y-2">
          {steps.length === 0 && <p className="text-xs text-muted-foreground">No steps defined. Without steps, this workflow auto-approves.</p>}
          {steps.map((s) => (
            <div key={s.id} className="flex items-center justify-between rounded border p-2 text-sm">
              <div>
                <span className="font-medium">Step {s.stepNumber}:</span> {s.stepName}
                <span className="ml-2 text-xs text-muted-foreground">({s.approverRoles?.join(", ")})</span>
              </div>
              <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => deleteStep.mutateAsync({ wfId: workflowId, stepId: s.id }).then(() => { qc.invalidateQueries({ queryKey: getListApprovalStepsQueryKey(workflowId) }); toast({ title: "Step removed" }); })}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
          {showAddStep && (
            <form onSubmit={handleSubmit(onAddStep)} className="flex gap-2 items-end mt-2">
              <div className="flex-1"><Input placeholder="Step name" {...register("stepName", { required: true })} className="h-7 text-xs" /></div>
              <div className="w-12"><Input type="number" placeholder="#" {...register("stepNumber")} className="h-7 text-xs" /></div>
              <select {...register("approverRole")} className="h-7 text-xs rounded-md border border-input bg-background px-2">
                <option value="approver">approver</option>
                <option value="tenant_admin">admin</option>
                <option value="super_admin">super admin</option>
              </select>
              <Button type="submit" size="sm" className="h-7" disabled={createStep.isPending}>Add</Button>
            </form>
          )}
        </div>
      )}
    </CardContent>
  );
}

// ─── Reports ──────────────────────────────────────────────────────────────────

function ReportsTab() {
  const { data: supplierPerf, isLoading: spLoading } = useReportSupplierPerformance();
  const { data: summary, isLoading: summaryLoading } = useReportPoSummary({});

  type SupRow = { supplierId?: number; supplierName?: string; totalOrders: number; totalValue: number; avgOrderValue: number };
  type SummRow = { status: string; count: number; total: number };

  const suppliers: SupRow[] = Array.isArray(supplierPerf) ? (supplierPerf as SupRow[]) : [];
  const summaryRows: SummRow[] = Array.isArray(summary) ? (summary as SummRow[]) : [];
  const grandTotal = summaryRows.reduce((s, r) => s + Number(r.total ?? 0), 0);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">PO Summary by Status</CardTitle></CardHeader>
          <CardContent>
            {summaryLoading ? <Skeleton className="h-40" /> : summaryRows.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">No purchase order data yet</div>
            ) : (
              <>
                <div className="space-y-2">
                  {summaryRows.map((r) => (
                    <div key={r.status} className="flex items-center justify-between py-2 border-b last:border-0">
                      <div className="flex items-center gap-2">
                        <StatusBadge status={r.status} />
                        <span className="text-sm text-muted-foreground">{r.count} order{r.count !== 1 ? "s" : ""}</span>
                      </div>
                      <span className="font-medium">{fmtCurrency(r.total)}</span>
                    </div>
                  ))}
                </div>
                <div className="flex justify-between pt-3 font-bold text-sm">
                  <span>Grand Total</span>
                  <span>{fmtCurrency(grandTotal)}</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Supplier Performance</CardTitle></CardHeader>
          <CardContent>
            {spLoading ? <Skeleton className="h-40" /> : suppliers.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">No supplier data yet</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Supplier</TableHead>
                    <TableHead className="text-right">Orders</TableHead>
                    <TableHead className="text-right">Total Value</TableHead>
                    <TableHead className="text-right">Avg Order</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {suppliers.map((s, i) => (
                    <TableRow key={s.supplierId ?? i}>
                      <TableCell>{s.supplierName ?? "Unknown"}</TableCell>
                      <TableCell className="text-right">{s.totalOrders}</TableCell>
                      <TableCell className="text-right font-medium">{fmtCurrency(s.totalValue)}</TableCell>
                      <TableCell className="text-right">{fmtCurrency(s.avgOrderValue)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Shared: Decision Dialog ──────────────────────────────────────────────────

function DecisionDialog({ open, title, onClose, onConfirm, isPending }: {
  open: boolean; title: string; onClose: () => void;
  onConfirm: (comment: string) => Promise<void>; isPending: boolean;
}) {
  const [comment, setComment] = useState("");
  useEffect(() => { if (!open) setComment(""); }, [open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Add an optional comment for this decision.</DialogDescription>
        </DialogHeader>
        <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} placeholder="Comments (optional)..." />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onConfirm(comment)} disabled={isPending}>
            {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
