import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useForm, Controller, useFieldArray, Control } from "react-hook-form";
import {
  useListQuotations,
  useGetQuotation,
  useCreateQuotation,
  useDeleteQuotation,
  useUpdateQuotation,
  useSendQuotation,
  useConvertQuotationToSo,
  useAddQuotationLine,
  useUpdateQuotationLine,
  useDeleteQuotationLine,
  getListQuotationsQueryKey,
  getGetQuotationQueryKey,
  useListSalesOrders,
  useGetSalesOrder,
  useCreateSalesOrder,
  useDeleteSalesOrder,
  useConfirmSalesOrder,
  useCancelSalesOrder,
  getListSalesOrdersQueryKey,
  getGetSalesOrderQueryKey,
  useListPickSlips,
  useGetPickSlip,
  getListPickSlipsQueryKey,
  useGetPickProgress,
  getGetPickProgressQueryKey,
  type PickProgressResponse,
  useListDespatches,
  useGetDespatch,
  useCreateDespatch,
  useConfirmDespatch,
  getListDespatchesQueryKey,
  getGetDespatchQueryKey,
  useListCustomerInvoices,
  useGetCustomerInvoice,
  useCreateCustomerInvoice,
  useSendCustomerInvoice,
  getListCustomerInvoicesQueryKey,
  useListCreditNotes,
  useCreateCreditNote,
  useIssueCreditNote,
  getListCreditNotesQueryKey,
  useListRmaOrders,
  useGetRmaOrder,
  useCreateRmaOrder,
  useAuthorizeRma,
  useReceiveRma,
  useProcessRma,
  getListRmaOrdersQueryKey,
  useGetSalesDashboard,
  useListBackorders,
  useReleaseBackorder,
  useCancelBackorder,
  ListBackordersStatus,
  useCancelDespatch,
  useVoidInvoice,
  useCancelRma,
  useReportCustomerStatement,
  getReportCustomerStatementQueryKey,
  useListCustomers,
  useListWarehouses,
  useListItems,
} from "@workspace/api-client-react";
import type {
  Quotation,
  QuotationDetail,
  QuotationLineInput,
  SalesOrder,
  SalesOrderDetail,
  PickSlip,
  PickSlipDetail,
  Despatch,
  DespatchDetail,
  CustomerInvoice,
  CustomerInvoiceDetail,
  CreditNote,
  RmaOrder,
  RmaDetail,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  Trash2,
  Search,
  RefreshCw,
  TrendingUp,
  Package,
  FileText,
  Truck,
  ReceiptText,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Send,
  ArrowRight,
  ClipboardList,
  BadgeDollarSign,
  AlertCircle,
  AlertTriangle,
  Printer,
  BarChart2,
  User,
  Clock,
  Image as ImageIcon,
  Pencil,
  Download,
} from "lucide-react";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt(val: string | number | null | undefined, decimals = 2): string {
  const n = Number(val ?? 0);
  return isNaN(n) ? "0.00" : n.toFixed(decimals);
}

function fmtDate(val: string | null | undefined): string {
  if (!val) return "—";
  return new Date(val).toLocaleDateString();
}

function fmtDateTime(val: string | Date | null | undefined): string {
  if (!val) return "—";
  const d = val instanceof Date ? val : new Date(val);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700",
  sent: "bg-blue-100 text-blue-700",
  accepted: "bg-green-100 text-green-700",
  rejected: "bg-red-100 text-red-700",
  expired: "bg-orange-100 text-orange-700",
  converted: "bg-purple-100 text-purple-700",
  confirmed: "bg-green-100 text-green-700",
  picking: "bg-yellow-100 text-yellow-700",
  partially_despatched: "bg-yellow-100 text-yellow-700",
  despatched: "bg-blue-100 text-blue-700",
  invoiced: "bg-purple-100 text-purple-700",
  cancelled: "bg-red-100 text-red-700",
  pending: "bg-yellow-100 text-yellow-700",
  picked: "bg-green-100 text-green-700",
  authorized: "bg-blue-100 text-blue-700",
  received: "bg-teal-100 text-teal-700",
  processed: "bg-purple-100 text-purple-700",
  closed: "bg-gray-100 text-gray-700",
  paid: "bg-green-100 text-green-700",
  issued: "bg-teal-100 text-teal-700",
};

function StatusBadge({ status }: { status?: string }) {
  const s = status ?? "";
  const cls = STATUS_COLORS[s] ?? "bg-gray-100 text-gray-700";
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}
    >
      {s.replace(/_/g, " ")}
    </span>
  );
}

// ── Line editor shared sub-component ─────────────────────────────────────────

type LineField = {
  id: string;
  itemId?: number;
  description?: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxPct: number;
};

/** Minimal form shape accepted by LineItemEditor — both QuotForm and SoForm satisfy this. */
type LineEditorFormBase = { lines: LineField[] };

type ItemOption = { id: number; code: string; name: string; description?: string | null; salesPrice?: string | null; unitCost?: string | null };

/**
 * Free-text item code entry. The user types an item code; on blur it is matched
 * case-insensitively against the known items. A match resolves the line to that
 * item; an unknown code is rejected (kept visible with an error, no item set);
 * an empty field clears the item (description-only lines remain allowed).
 */
function ItemCodeInput({
  value,
  items,
  onResolve,
}: {
  value?: number;
  items: ItemOption[];
  onResolve: (item: ItemOption | null) => void;
}) {
  const codeForId = (id?: number) => items.find((i) => i.id === id)?.code ?? "";
  const [text, setText] = useState(() => codeForId(value));
  const [error, setError] = useState(false);

  // When the resolved item id (or the items list) changes, reflect the canonical
  // code in the input. Guarded to a known id so rejecting a code never wipes the
  // text the user typed.
  useEffect(() => {
    if (value != null) {
      const c = codeForId(value);
      if (c) { setText(c); setError(false); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, items]);

  const commit = () => {
    const t = text.trim();
    if (!t) { setError(false); onResolve(null); return; }
    const match = items.find((i) => (i.code ?? "").toLowerCase() === t.toLowerCase());
    if (match) { setError(false); setText(match.code); onResolve(match); }
    else { setError(true); onResolve(null); }
  };

  return (
    <div>
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
        placeholder="Item code"
        className={`h-7 text-xs w-24 ${error ? "border-red-500 focus-visible:ring-red-500" : ""}`}
      />
      {error && <p className="text-[10px] text-red-600 mt-0.5">Not found</p>}
    </div>
  );
}

type DetailLine = {
  id?: number;
  lineNumber?: number;
  itemId?: number | null;
  itemCode?: string | null;
  itemName?: string | null;
  description?: string | null;
  quantity?: string;
  unitPrice?: string;
  lineTotal?: string;
};

/**
 * One row of the quotation detail line table. Read-only unless `editable`, in
 * which case the item, quantity and unit price become inline-editable and a
 * remove control is shown. Edits are committed on blur via `onUpdate`.
 */
function QuoteDetailLineRow({
  line,
  items,
  editable,
  onUpdate,
  onRemove,
}: {
  line: DetailLine;
  items: ItemOption[];
  editable: boolean;
  onUpdate: (lineId: number, data: QuotationLineInput) => void;
  onRemove: (lineId: number) => void;
}) {
  if (!editable) {
    return (
      <TableRow>
        <TableCell className="text-xs">{line.lineNumber}</TableCell>
        <TableCell className="text-xs">
          {line.itemCode ? `${line.itemCode} – ${line.itemName}` : line.description ?? "—"}
        </TableCell>
        <TableCell className="text-xs text-right">{fmt(line.quantity, 0)}</TableCell>
        <TableCell className="text-xs text-right">${fmt(line.unitPrice)}</TableCell>
        <TableCell className="text-xs text-right font-medium">${fmt(line.lineTotal)}</TableCell>
      </TableRow>
    );
  }

  return (
    <TableRow>
      <TableCell className="text-xs align-top pt-3">{line.lineNumber}</TableCell>
      <TableCell className="p-1">
        <ItemCodeInput
          value={line.itemId ?? undefined}
          items={items}
          onResolve={(it) => {
            if (!line.id || !it) return;
            const price = it.salesPrice ?? it.unitCost;
            onUpdate(line.id, {
              itemId: it.id,
              itemCode: it.code,
              itemName: it.name,
              description: it.description ?? it.name,
              unitPrice: price != null ? Number(price) : undefined,
            });
          }}
        />
        {!line.itemId && line.description ? (
          <p className="text-[10px] text-muted-foreground mt-0.5">{line.description}</p>
        ) : null}
      </TableCell>
      <TableCell className="p-1 align-top">
        <Input
          key={`qty-${line.id}-${line.quantity}`}
          type="number"
          min={0}
          defaultValue={line.quantity ?? "0"}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (line.id && Number.isFinite(v) && v !== Number(line.quantity)) {
              onUpdate(line.id, { quantity: v });
            }
          }}
          className="h-7 text-xs w-16 text-right ml-auto"
        />
      </TableCell>
      <TableCell className="p-1 align-top">
        <Input
          key={`price-${line.id}-${line.unitPrice}`}
          type="number"
          min={0}
          step="0.01"
          defaultValue={line.unitPrice ?? "0"}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (line.id && Number.isFinite(v) && v !== Number(line.unitPrice)) {
              onUpdate(line.id, { unitPrice: v });
            }
          }}
          className="h-7 text-xs w-20 text-right ml-auto"
        />
      </TableCell>
      <TableCell className="text-xs text-right font-medium align-top pt-3">
        ${fmt(line.lineTotal)}
      </TableCell>
      <TableCell className="p-1 align-top">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={() => line.id && onRemove(line.id)}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </Button>
      </TableCell>
    </TableRow>
  );
}

function LineItemEditor({
  fields,
  control,
  onAdd,
  onRemove,
  items,
  setValue,
}: {
  fields: LineField[];
  control: Control<LineEditorFormBase>;
  onAdd: () => void;
  onRemove: (idx: number) => void;
  items: ItemOption[];
  setValue?: (idx: number, patch: { description?: string; unitPrice?: number }) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">Lines</Label>
        <Button type="button" size="sm" variant="outline" onClick={onAdd}>
          <Plus className="w-3 h-3 mr-1" /> Add Line
        </Button>
      </div>
      <div className="border rounded-md overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="w-24">Item</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="w-20">Qty</TableHead>
              <TableHead className="w-24">Unit Price</TableHead>
              <TableHead className="w-16">Tax%</TableHead>
              <TableHead className="w-8" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((field, idx) => (
              <TableRow key={field.id ?? 0}>
                <TableCell className="p-1">
                  <Controller
                    control={control}
                    name={`lines.${idx}.itemId`}
                    render={({ field: f }) => (
                      <ItemCodeInput
                        value={f.value}
                        items={items}
                        onResolve={(it) => {
                          f.onChange(it ? it.id : undefined);
                          if (it && setValue) {
                            const price = it.salesPrice ?? it.unitCost;
                            setValue(idx, {
                              description: it.description ?? it.name,
                              unitPrice: price != null ? Number(price) : undefined,
                            });
                          }
                        }}
                      />
                    )}
                  />
                </TableCell>
                <TableCell className="p-1">
                  <Controller
                    control={control}
                    name={`lines.${idx}.description`}
                    render={({ field: f }) => (
                      <Input
                        {...f}
                        value={f.value ?? ""}
                        className="h-7 text-xs"
                        placeholder="Description"
                      />
                    )}
                  />
                </TableCell>
                <TableCell className="p-1">
                  <Controller
                    control={control}
                    name={`lines.${idx}.quantity`}
                    render={({ field: f }) => (
                      <Input
                        {...f}
                        type="number"
                        min="0"
                        step="1"
                        className="h-7 text-xs w-16"
                      />
                    )}
                  />
                </TableCell>
                <TableCell className="p-1">
                  <Controller
                    control={control}
                    name={`lines.${idx}.unitPrice`}
                    render={({ field: f }) => (
                      <Input
                        {...f}
                        type="number"
                        min="0"
                        step="0.01"
                        className="h-7 text-xs w-20"
                      />
                    )}
                  />
                </TableCell>
                <TableCell className="p-1">
                  <Controller
                    control={control}
                    name={`lines.${idx}.taxPct`}
                    render={({ field: f }) => (
                      <Input
                        {...f}
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        className="h-7 text-xs w-16"
                      />
                    )}
                  />
                </TableCell>
                <TableCell className="p-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => onRemove(idx)}
                  >
                    <XCircle className="w-4 h-4 text-muted-foreground" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {fields.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={6}
                  className="text-center text-muted-foreground text-xs py-4"
                >
                  No lines. Click "Add Line" to start.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Dashboard Tab ─────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function fmtCurrencyCompact(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function KpiCard({
  title,
  value,
  hint,
  icon,
  tone,
}: {
  title: string;
  value: string;
  hint?: string;
  icon: React.ReactNode;
  tone?: "default" | "warning" | "danger" | "success";
}) {
  const toneCls =
    tone === "danger"
      ? "text-red-600"
      : tone === "warning"
        ? "text-orange-600"
        : tone === "success"
          ? "text-emerald-600"
          : "text-foreground";
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          {icon} {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-2xl font-bold ${toneCls}`}>{value}</div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function DashboardTab({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const { data, isLoading, isError, refetch, isFetching } = useGetSalesDashboard();

  const series = useMemo(() => {
    const rows = data?.monthlySeries ?? [];
    return rows.map((r) => {
      // Display "MMM YY" for compact axis labels.
      const [y, m] = String(r.period ?? "").split("-");
      const dt = y && m ? new Date(Number(y), Number(m) - 1, 1) : null;
      const label = dt
        ? dt.toLocaleString(undefined, { month: "short", year: "2-digit" })
        : String(r.period ?? "");
      return {
        period: label,
        revenue: Number(r.revenue ?? 0),
        orderCount: Number(r.orderCount ?? 0),
        invoiceCount: Number(r.invoiceCount ?? 0),
      };
    });
  }, [data]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <Card>
        <CardContent className="py-12 text-center space-y-3">
          <AlertCircle className="w-8 h-8 text-red-500 mx-auto" />
          <p className="text-sm text-muted-foreground">
            Could not load the sales dashboard.
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="w-4 h-4 mr-1.5" /> Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const hasOverdue = data.overdueInvoices.count > 0;

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <KpiCard
          title="Open Quotations"
          value={String(data.openQuotationsCount)}
          hint="Draft + sent, awaiting decision"
          icon={<FileText className="w-4 h-4" />}
        />
        <KpiCard
          title="Open SO Value"
          value={fmtCurrencyCompact(data.openSalesOrders.value)}
          hint={`${data.openSalesOrders.count} active order${data.openSalesOrders.count === 1 ? "" : "s"}`}
          icon={<ClipboardList className="w-4 h-4" />}
        />
        <KpiCard
          title="Pending Despatch"
          value={String(data.pendingDespatchCount)}
          hint="Confirmed orders to ship"
          icon={<Truck className="w-4 h-4" />}
          tone={data.pendingDespatchCount > 0 ? "warning" : "default"}
        />
        <KpiCard
          title="Outstanding Invoices"
          value={fmtCurrencyCompact(data.outstandingInvoices.total)}
          hint={`${data.outstandingInvoices.count} unpaid`}
          icon={<ReceiptText className="w-4 h-4" />}
        />
        <KpiCard
          title="Overdue Invoices"
          value={fmtCurrencyCompact(data.overdueInvoices.total)}
          hint={`${data.overdueInvoices.count} past due`}
          icon={<AlertCircle className="w-4 h-4" />}
          tone={hasOverdue ? "danger" : "success"}
        />
      </div>

      {/* Quick actions */}
      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-sm font-medium">Quick actions</CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={`w-4 h-4 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => onNavigate("quotations")}>
              <FileText className="w-4 h-4 mr-1.5" /> View Quotations
            </Button>
            <Button size="sm" variant="outline" onClick={() => onNavigate("orders")}>
              <ClipboardList className="w-4 h-4 mr-1.5" /> Sales Orders
            </Button>
            <Button size="sm" variant="outline" onClick={() => onNavigate("despatches")}>
              <Truck className="w-4 h-4 mr-1.5" /> Despatches
            </Button>
            <Button size="sm" variant="outline" onClick={() => onNavigate("invoices")}>
              <ReceiptText className="w-4 h-4 mr-1.5" /> Invoices
            </Button>
            <Button size="sm" variant="outline" onClick={() => onNavigate("backorders")}>
              <AlertCircle className="w-4 h-4 mr-1.5" /> Backorders
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-indigo-500" /> Monthly Revenue
            </CardTitle>
          </CardHeader>
          <CardContent>
            {series.length === 0 ? (
              <p className="text-sm text-muted-foreground py-12 text-center">
                No invoice history yet.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => fmtCurrencyCompact(v)} width={56} />
                  <Tooltip
                    formatter={(v: number) => [`$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`, "Revenue"]}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Bar dataKey="revenue" fill="#6366f1" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-emerald-500" /> Monthly Order Volume
            </CardTitle>
          </CardHeader>
          <CardContent>
            {series.length === 0 ? (
              <p className="text-sm text-muted-foreground py-12 text-center">
                No order history yet.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border/50" />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} width={32} />
                  <Tooltip contentStyle={{ fontSize: 12 }} />
                  <Line
                    type="monotone"
                    dataKey="orderCount"
                    name="Orders"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={{ r: 3 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="invoiceCount"
                    name="Invoices"
                    stroke="#6366f1"
                    strokeWidth={2}
                    strokeDasharray="4 4"
                    dot={{ r: 3 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Quotations Tab ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

type QuotLineForm = {
  itemId?: number;
  description?: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxPct: number;
};
type QuotForm = {
  customerId?: number;
  customerName?: string;
  customerEmail?: string;
  expiryDate?: string;
  paymentTerms?: string;
  notes?: string;
  lines: QuotLineForm[];
};

function QuotationsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [sendId, setSendId] = useState<number | null>(null);
  const [sendEmail, setSendEmail] = useState("");
  const [editId, setEditId] = useState<number | null>(null);

  const { data: list, isLoading } = useListQuotations({
    search: search || undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
    limit: 50,
  });
  const { data: detail } = useGetQuotation(detailId!, {
    query: {
      enabled: detailId !== null,
      queryKey: getGetQuotationQueryKey(detailId!),
    },
  });
  const { data: customers } = useListCustomers({ limit: 200 });
  const { data: itemsData } = useListItems({ limit: 500 });

  const createMut = useCreateQuotation();
  const updateMut = useUpdateQuotation();
  const sendMut = useSendQuotation();
  const convertMut = useConvertQuotationToSo();
  const deleteMut = useDeleteQuotation();
  const addLineMut = useAddQuotationLine();
  const updateLineMut = useUpdateQuotationLine();
  const deleteLineMut = useDeleteQuotationLine();
  type EditQuotForm = {
    customerId?: number;
    customerName?: string;
    customerEmail?: string;
    expiryDate?: string;
    paymentTerms?: string;
    notes?: string;
    deliveryAddressLine1?: string;
    deliveryAddressLine2?: string;
    deliveryCity?: string;
    deliveryState?: string;
    deliveryPostalCode?: string;
    deliveryCountry?: string;
  };
  const editForm = useForm<EditQuotForm>();

  const form = useForm<QuotForm>({ defaultValues: { lines: [] } });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "lines" });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListQuotationsQueryKey() });

  const refreshDetail = () => {
    if (detailId != null) qc.invalidateQueries({ queryKey: getGetQuotationQueryKey(detailId) });
    invalidate();
  };

  async function handleAddDetailLine() {
    if (detailId == null) return;
    try {
      await addLineMut.mutateAsync({ id: detailId, data: { lineType: "stock", quantity: 1, unitPrice: 0 } });
      refreshDetail();
    } catch {
      toast({ title: "Failed to add line", variant: "destructive" });
    }
  }

  async function handleUpdateDetailLine(lineId: number, data: QuotationLineInput) {
    if (detailId == null) return;
    try {
      await updateLineMut.mutateAsync({ id: detailId, lineId, data });
      refreshDetail();
    } catch {
      toast({ title: "Failed to update line", variant: "destructive" });
    }
  }

  async function handleRemoveDetailLine(lineId: number) {
    if (detailId == null) return;
    try {
      await deleteLineMut.mutateAsync({ id: detailId, lineId });
      refreshDetail();
    } catch {
      toast({ title: "Failed to remove line", variant: "destructive" });
    }
  }

  async function onSubmit(values: QuotForm) {
    try {
      await createMut.mutateAsync({
        data: {
          customerId: values.customerId,
          customerName: values.customerName,
          customerEmail: values.customerEmail,
          expiryDate: values.expiryDate,
          paymentTerms: values.paymentTerms,
          notes: values.notes,
          lines: values.lines.map((l, i) => ({
            lineNumber: i + 1,
            lineType: "stock" as const,
            itemId: l.itemId,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discountPct: l.discountPct,
            taxPct: l.taxPct,
          })),
        },
      });
      toast({ title: "Quotation created" });
      setShowCreate(false);
      form.reset({ lines: [] });
      invalidate();
    } catch {
      toast({ title: "Failed to create quotation", variant: "destructive" });
    }
  }

  function openSendDialog(id: number, defaultEmail?: string | null) {
    setSendId(id);
    setSendEmail(defaultEmail ?? "");
  }

  async function handleSendConfirm() {
    if (!sendId) return;
    if (!sendEmail || !/^\S+@\S+\.\S+$/.test(sendEmail)) {
      toast({ title: "Enter a valid email address", variant: "destructive" });
      return;
    }
    try {
      await sendMut.mutateAsync({ id: sendId, data: { email: sendEmail } as never });
      toast({ title: "Quotation sent", description: `Sent to ${sendEmail}` });
      invalidate();
      qc.invalidateQueries({ queryKey: getGetQuotationQueryKey(sendId) });
      setSendId(null);
    } catch (err) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
        ?? "Failed to send";
      toast({ title: msg, variant: "destructive" });
    }
  }

  function openEditDialog(q: Quotation) {
    setEditId(q.id ?? null);
    editForm.reset({
      customerId: q.customerId ?? undefined,
      customerName: q.customerName ?? "",
      customerEmail: q.customerEmail ?? "",
      expiryDate: q.expiryDate ?? "",
      paymentTerms: q.paymentTerms ?? "",
      notes: q.notes ?? "",
      deliveryAddressLine1: q.deliveryAddressLine1 ?? "",
      deliveryAddressLine2: q.deliveryAddressLine2 ?? "",
      deliveryCity: q.deliveryCity ?? "",
      deliveryState: q.deliveryState ?? "",
      deliveryPostalCode: q.deliveryPostalCode ?? "",
      deliveryCountry: q.deliveryCountry ?? "",
    });
  }

  async function handleEditSubmit(values: EditQuotForm) {
    if (!editId) return;
    if (!values.customerId) {
      toast({ title: "Select a customer", description: "Pick a customer from Master Data before saving.", variant: "destructive" });
      return;
    }
    // Normalize empty strings on every optional field to an explicit null so
    // the backend always sees a definite "clear this column" signal — no more
    // ambiguity between "user wants to clear" and "user left blank". Required
    // fields (customerId) are validated above.
    const clearableKeys = [
      "customerEmail",
      "customerRef",
      "deliveryAddressLine1",
      "deliveryAddressLine2",
      "deliveryCity",
      "deliveryState",
      "deliveryPostalCode",
      "deliveryCountry",
      "expiryDate",
      "requestedDate",
      "paymentTerms",
      "notes",
      "internalNotes",
    ];
    const payload: Record<string, unknown> = { ...values };
    for (const k of clearableKeys) {
      if (payload[k] === "") payload[k] = null;
    }
    try {
      await updateMut.mutateAsync({ id: editId, data: payload as typeof values });
      toast({ title: "Quotation updated" });
      invalidate();
      qc.invalidateQueries({ queryKey: getGetQuotationQueryKey(editId) });
      setEditId(null);
    } catch (e: unknown) {
      const err = e as {
        data?: { error?: string };
        response?: { data?: { error?: string } };
        message?: string;
      };
      const msg =
        err?.data?.error ??
        err?.response?.data?.error ??
        err?.message ??
        "Unknown error";
      toast({ title: "Failed to update quotation", description: msg, variant: "destructive" });
    }
  }

  async function handleDownload(id: number, code?: string) {
    try {
      const res = await fetch(`/api/sales/quotations/${id}/pdf`, { credentials: "include" });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${code ?? "quotation"}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Failed to download PDF", variant: "destructive" });
    }
  }

  async function handleConvert(id: number) {
    try {
      const res = await convertMut.mutateAsync({ id });
      toast({
        title: (res as { alreadyConverted?: boolean }).alreadyConverted
          ? "Already converted"
          : "Converted to Sales Order",
      });
      invalidate();
      qc.invalidateQueries({ queryKey: getListSalesOrdersQueryKey() });
    } catch {
      toast({ title: "Failed to convert", variant: "destructive" });
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteMut.mutateAsync({ id });
      toast({ title: "Quotation deleted" });
      if (detailId === id) setDetailId(null);
      invalidate();
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    }
  }

  const custList =
    (customers as { customers?: Array<{
      id: number;
      code?: string | null;
      name: string;
      email?: string | null;
      shippingAddressLine1?: string | null;
      shippingAddressLine2?: string | null;
      shippingCity?: string | null;
      shippingState?: string | null;
      shippingPostalCode?: string | null;
      shippingCountry?: string | null;
    }> })?.customers ?? [];
  const itemsList =
    (itemsData as { items?: ItemOption[] })?.items ?? [];
  const quotations = (list as { data?: Quotation[] })?.data ?? [];
  const det = detail as QuotationDetail | undefined;
  const customerCodeById = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of custList) if (c.code) m.set(c.id, c.code);
    return m;
  }, [custList]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search quotations..."
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="accepted">Accepted</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="converted">Converted</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-1" /> New Quotation
        </Button>
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Account</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Expiry</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={9}>
                  <Skeleton className="h-8 w-full" />
                </TableCell>
              </TableRow>
            )}
            {!isLoading && quotations.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                  No quotations found
                </TableCell>
              </TableRow>
            )}
            {quotations.map((q) => (
              <TableRow
                key={q.id ?? 0}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => setDetailId(q.id ?? null)}
              >
                <TableCell className="font-mono text-sm">{q.code ?? ""}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {q.customerId != null ? (customerCodeById.get(q.customerId) ?? "—") : "—"}
                </TableCell>
                <TableCell>{q.customerName ?? "—"}</TableCell>
                <TableCell>{fmtDate(q.expiryDate)}</TableCell>
                <TableCell>
                  <StatusBadge status={q.status} />
                </TableCell>
                <TableCell className="text-right font-medium">${fmt(q.total)}</TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {fmtDate(q.createdAt)}
                </TableCell>
                <TableCell className="max-w-[200px]">
                  {q.notes?.trim() ? (
                    <span className="block truncate text-xs text-muted-foreground" title={q.notes}>
                      {q.notes}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setDetailId(q.id ?? null)}>
                        View Details
                      </DropdownMenuItem>
                      {["draft", "sent"].includes(q.status ?? "") && (
                        <DropdownMenuItem onClick={() => openEditDialog(q)}>
                          <Pencil className="w-4 h-4 mr-2" /> Edit Quote
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => handleDownload(q.id!, q.code)}>
                        <Download className="w-4 h-4 mr-2" /> Download PDF
                      </DropdownMenuItem>
                      {["draft", "sent"].includes(q.status ?? "") && (
                        <DropdownMenuItem onClick={() => openSendDialog(q.id!, q.customerEmail)}>
                          <Send className="w-4 h-4 mr-2" /> Send to Customer
                        </DropdownMenuItem>
                      )}
                      {["draft", "sent", "accepted"].includes(q.status ?? "") &&
                        !q.convertedSoId && (
                          <DropdownMenuItem onClick={() => handleConvert(q.id!)}>
                            <ArrowRight className="w-4 h-4 mr-2" /> Convert to Sales Order
                          </DropdownMenuItem>
                        )}
                      <DropdownMenuSeparator />
                      {["draft", "sent"].includes(q.status ?? "") && (
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => handleDelete(q.id!)}
                        >
                          Delete
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Create Dialog */}
      <Dialog
        open={showCreate}
        onOpenChange={(v) => {
          setShowCreate(v);
          if (!v) form.reset({ lines: [] });
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Quotation</DialogTitle>
            <DialogDescription>Create a quotation for a customer.</DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Customer</Label>
                <Controller
                  control={form.control}
                  name="customerId"
                  render={({ field: f }) => (
                    <Select
                      value={f.value ? String(f.value) : ""}
                      onValueChange={(v) => {
                        f.onChange(v ? Number(v) : undefined);
                        const c = custList.find((c) => c.id === Number(v));
                        if (c) {
                          form.setValue("customerName", c.name);
                          form.setValue("customerEmail", c.email ?? undefined);
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select customer..." />
                      </SelectTrigger>
                      <SelectContent>
                        {custList.map((c) => (
                          <SelectItem key={c.id ?? 0} value={String(c.id)}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div>
                <Label>Customer Email</Label>
                <Input
                  {...form.register("customerEmail")}
                  placeholder="customer@example.com"
                />
              </div>
              <div>
                <Label>Expiry Date</Label>
                <Input {...form.register("expiryDate")} type="date" />
              </div>
              <div>
                <Label>Payment Terms</Label>
                <Input {...form.register("paymentTerms")} placeholder="Net 30" />
              </div>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea
                {...form.register("notes")}
                placeholder="Optional notes..."
                rows={2}
              />
            </div>
            <LineItemEditor
              fields={fields as LineField[]}
              control={form.control as unknown as Control<LineEditorFormBase>}
              items={itemsList}
              onAdd={() =>
                append({ quantity: 1, unitPrice: 0, discountPct: 0, taxPct: 10 })
              }
              onRemove={remove}
              setValue={(idx, patch) => {
                if (patch.description !== undefined) form.setValue(`lines.${idx}.description`, patch.description);
                if (patch.unitPrice !== undefined) form.setValue(`lines.${idx}.unitPrice`, patch.unitPrice);
              }}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowCreate(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createMut.isPending}>
                {createMut.isPending ? "Creating..." : "Create Quotation"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Detail Dialog */}
      <Dialog open={detailId !== null} onOpenChange={(v) => { if (!v) setDetailId(null); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{det?.code ?? "Quotation"}</DialogTitle>
            <DialogDescription className="flex items-center gap-2 flex-wrap">
              {det?.customerId != null && customerCodeById.get(det.customerId) && (
                <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted">
                  {customerCodeById.get(det.customerId)}
                </span>
              )}
              <span>{det?.customerName ?? ""}</span>
              {det?.status && <StatusBadge status={det.status} />}
            </DialogDescription>
          </DialogHeader>
          {det && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Expiry:</span>{" "}
                  {fmtDate(det.expiryDate)}
                </div>
                <div>
                  <span className="text-muted-foreground">Payment:</span>{" "}
                  {det.paymentTerms ?? "—"}
                </div>
                <div>
                  <span className="text-muted-foreground">Currency:</span>{" "}
                  {det.currencyCode}
                </div>
              </div>
              <div className="text-sm">
                <span className="text-muted-foreground">Notes:</span>{" "}
                {det.notes?.trim() ? (
                  <span className="whitespace-pre-wrap">{det.notes}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
              {(() => {
                const linesEditable =
                  ["draft", "sent"].includes(det.status ?? "") && !det.convertedSoId;
                return (
                  <>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>#</TableHead>
                          <TableHead>Item</TableHead>
                          <TableHead className="text-right">Qty</TableHead>
                          <TableHead className="text-right">Unit Price</TableHead>
                          <TableHead className="text-right">Line Total</TableHead>
                          {linesEditable && <TableHead className="w-8" />}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {det.lines?.map((l) => (
                          <QuoteDetailLineRow
                            key={l.id ?? 0}
                            line={l}
                            items={itemsList}
                            editable={linesEditable}
                            onUpdate={handleUpdateDetailLine}
                            onRemove={handleRemoveDetailLine}
                          />
                        ))}
                        {linesEditable && (det.lines?.length ?? 0) === 0 && (
                          <TableRow>
                            <TableCell colSpan={6} className="text-xs text-center text-muted-foreground py-3">
                              No lines yet. Add one below.
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                    {linesEditable && (
                      <div className="flex justify-start">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={handleAddDetailLine}
                          disabled={addLineMut.isPending}
                        >
                          <Plus className="w-3 h-3 mr-1" /> Add Line
                        </Button>
                      </div>
                    )}
                    <div className="flex justify-end text-sm font-medium">
                      Total: ${fmt(det.total)}
                    </div>
                  </>
                );
              })()}
              <div className="flex gap-2 justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleDownload(detailId!, det.code)}
                >
                  <Download className="w-3 h-3 mr-1" /> PDF
                </Button>
                {["draft", "sent"].includes(det.status ?? "") && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openSendDialog(detailId!, det.customerEmail)}
                  >
                    <Send className="w-3 h-3 mr-1" /> Send
                  </Button>
                )}
                {["draft", "sent", "accepted"].includes(det.status ?? "") &&
                  !det.convertedSoId && (
                    <Button size="sm" onClick={() => handleConvert(detailId!)}>
                      <ArrowRight className="w-3 h-3 mr-1" /> Convert to SO
                    </Button>
                  )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Send Quote Dialog */}
      <Dialog open={sendId !== null} onOpenChange={(v) => { if (!v) setSendId(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Send Quotation</DialogTitle>
            <DialogDescription>
              The quotation PDF will be emailed to the address below.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="send-email">Customer Email</Label>
            <Input
              id="send-email"
              type="email"
              value={sendEmail}
              onChange={(e) => setSendEmail(e.target.value)}
              placeholder="customer@example.com"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSendId(null)}>Cancel</Button>
            <Button onClick={handleSendConfirm} disabled={sendMut.isPending}>
              <Send className="w-4 h-4 mr-2" />
              {sendMut.isPending ? "Sending..." : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Quote Dialog */}
      <Dialog open={editId !== null} onOpenChange={(v) => { if (!v) setEditId(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Quotation</DialogTitle>
            <DialogDescription>
              Update header details. To edit lines, use View Details.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={editForm.handleSubmit(handleEditSubmit)}
            className="space-y-3"
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label>Customer</Label>
                <Controller
                  control={editForm.control}
                  name="customerId"
                  render={({ field: f }) => (
                    <Select
                      value={f.value ? String(f.value) : ""}
                      onValueChange={(v) => {
                        const id = v ? Number(v) : undefined;
                        f.onChange(id);
                        const c = custList.find((c) => c.id === id);
                        if (c) {
                          editForm.setValue("customerName", c.name);
                          editForm.setValue("customerEmail", c.email ?? "");
                          editForm.setValue("deliveryAddressLine1", c.shippingAddressLine1 ?? "");
                          editForm.setValue("deliveryAddressLine2", c.shippingAddressLine2 ?? "");
                          editForm.setValue("deliveryCity", c.shippingCity ?? "");
                          editForm.setValue("deliveryState", c.shippingState ?? "");
                          editForm.setValue("deliveryPostalCode", c.shippingPostalCode ?? "");
                          editForm.setValue("deliveryCountry", c.shippingCountry ?? "");
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select customer..." />
                      </SelectTrigger>
                      <SelectContent>
                        {custList.map((c) => (
                          <SelectItem key={c.id} value={String(c.id)}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div>
                <Label>Customer Email</Label>
                <Input type="email" {...editForm.register("customerEmail")} />
              </div>
              <div>
                <Label>Expiry Date</Label>
                <Input type="date" {...editForm.register("expiryDate")} />
              </div>
              <div className="col-span-2">
                <Label>Payment Terms</Label>
                <Input {...editForm.register("paymentTerms")} placeholder="Net 30" />
              </div>
            </div>
            <div className="border-t pt-3 space-y-3">
              <div className="text-sm font-medium">Ship-To Address</div>
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <Label>Address Line 1</Label>
                  <Input {...editForm.register("deliveryAddressLine1")} />
                </div>
                <div className="col-span-2">
                  <Label>Address Line 2</Label>
                  <Input {...editForm.register("deliveryAddressLine2")} />
                </div>
                <div>
                  <Label>City</Label>
                  <Input {...editForm.register("deliveryCity")} />
                </div>
                <div>
                  <Label>State / Region</Label>
                  <Input {...editForm.register("deliveryState")} />
                </div>
                <div>
                  <Label>Postal Code</Label>
                  <Input {...editForm.register("deliveryPostalCode")} />
                </div>
                <div>
                  <Label>Country</Label>
                  <Input {...editForm.register("deliveryCountry")} />
                </div>
              </div>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea {...editForm.register("notes")} rows={3} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditId(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateMut.isPending}>
                {updateMut.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Sales Orders Tab ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

type SoLineForm = {
  itemId?: number;
  description?: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxPct: number;
};
type SoForm = {
  customerId?: number;
  customerName?: string;
  customerEmail?: string;
  warehouseId?: number;
  requestedDate?: string;
  paymentTerms?: string;
  notes?: string;
  lines: SoLineForm[];
};
type DespatchLineForm = {
  soLineId: number;
  itemCode?: string;
  itemName?: string;
  quantity: number;
  unitPrice: number;
};
type DespatchForm = {
  trackingNumber?: string;
  carrier?: string;
  despatchDate?: string;
  notes?: string;
  lines: DespatchLineForm[];
};

function SalesOrdersTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [showDespatch, setShowDespatch] = useState<number | null>(null);

  const { data: list, isLoading } = useListSalesOrders({
    search: search || undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
    limit: 50,
  });
  const { data: detail } = useGetSalesOrder(detailId!, {
    query: {
      enabled: detailId !== null,
      queryKey: getGetSalesOrderQueryKey(detailId!),
    },
  });
  const { data: customers } = useListCustomers({ limit: 200 });
  const { data: warehouses } = useListWarehouses({ limit: 100 });
  const { data: itemsData } = useListItems({ limit: 500 });

  const createMut = useCreateSalesOrder();
  const confirmMut = useConfirmSalesOrder();
  const cancelMut = useCancelSalesOrder();
  const deleteMut = useDeleteSalesOrder();
  const createDespatchMut = useCreateDespatch();

  const form = useForm<SoForm>({ defaultValues: { lines: [] } });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "lines" });

  const despatchForm = useForm<DespatchForm>({ defaultValues: { lines: [] } });
  const { fields: despatchFields, remove: removeDespatch } = useFieldArray({
    control: despatchForm.control,
    name: "lines",
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListSalesOrdersQueryKey() });
    qc.invalidateQueries({ queryKey: getListDespatchesQueryKey() });
  };

  async function onCreate(values: SoForm) {
    try {
      await createMut.mutateAsync({
        data: {
          customerId: values.customerId,
          customerName: values.customerName,
          customerEmail: values.customerEmail,
          warehouseId: values.warehouseId,
          requestedDate: values.requestedDate,
          paymentTerms: values.paymentTerms,
          notes: values.notes,
          lines: values.lines.map((l, i) => ({
            lineNumber: i + 1,
            lineType: "stock" as const,
            itemId: l.itemId,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discountPct: l.discountPct,
            taxPct: l.taxPct,
          })),
        },
      });
      toast({ title: "Sales order created" });
      setShowCreate(false);
      form.reset({ lines: [] });
      invalidate();
    } catch {
      toast({ title: "Failed to create sales order", variant: "destructive" });
    }
  }

  async function handleConfirm(id: number) {
    try {
      await confirmMut.mutateAsync({ id });
      toast({ title: "Sales order confirmed and stock allocated" });
      invalidate();
      qc.invalidateQueries({ queryKey: getGetSalesOrderQueryKey(id) });
    } catch {
      toast({ title: "Failed to confirm", variant: "destructive" });
    }
  }

  async function handleCancel(id: number) {
    try {
      await cancelMut.mutateAsync({ id });
      toast({ title: "Sales order cancelled" });
      invalidate();
      qc.invalidateQueries({ queryKey: getGetSalesOrderQueryKey(id) });
    } catch {
      toast({ title: "Failed to cancel", variant: "destructive" });
    }
  }

  async function handleDelete(id: number) {
    try {
      await deleteMut.mutateAsync({ id });
      toast({ title: "Sales order deleted" });
      if (detailId === id) setDetailId(null);
      invalidate();
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    }
  }

  function openDespatch(soId: number) {
    const soDetail = detail as SalesOrderDetail | undefined;
    const lines: DespatchLineForm[] = (soDetail?.lines ?? [])
      .filter(
        (l) =>
          l.lineType === "stock" &&
          Number(l.quantity) > Number(l.despatched_qty ?? 0)
      )
      .map((l) => ({
        soLineId: l.id!,
        itemCode: l.itemCode ?? undefined,
        itemName: l.itemName ?? undefined,
        quantity: Number(l.quantity) - Number(l.despatched_qty ?? 0),
        unitPrice: Number(l.unitPrice),
      }));
    despatchForm.reset({ lines });
    setShowDespatch(soId);
  }

  async function onDespatch(values: DespatchForm) {
    if (!showDespatch) return;
    try {
      await createDespatchMut.mutateAsync({
        data: {
          soId: showDespatch,
          trackingNumber: values.trackingNumber,
          carrier: values.carrier,
          despatchDate: values.despatchDate,
          notes: values.notes,
          lines: values.lines.map((l) => ({
            soLineId: l.soLineId,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
          })),
        },
      });
      toast({ title: "Despatch created" });
      setShowDespatch(null);
      invalidate();
    } catch {
      toast({ title: "Failed to create despatch", variant: "destructive" });
    }
  }

  const custList =
    (customers as { customers?: Array<{
      id: number;
      code?: string | null;
      name: string;
      email?: string | null;
      shippingAddressLine1?: string | null;
      shippingAddressLine2?: string | null;
      shippingCity?: string | null;
      shippingState?: string | null;
      shippingPostalCode?: string | null;
      shippingCountry?: string | null;
    }> })?.customers ?? [];
  const warehouseList =
    (warehouses as { warehouses?: Array<{ id: number; name: string }> })?.warehouses ?? [];
  const itemsList = (itemsData as { items?: ItemOption[] })?.items ?? [];
  const orders = (list as { data?: SalesOrder[] })?.data ?? [];
  const det = detail as SalesOrderDetail | undefined;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search sales orders..."
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="confirmed">Confirmed</SelectItem>
            <SelectItem value="picking">Picking</SelectItem>
            <SelectItem value="partially_despatched">Partially Despatched</SelectItem>
            <SelectItem value="despatched">Despatched</SelectItem>
            <SelectItem value="invoiced">Invoiced</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-1" /> New Order
        </Button>
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Requested</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={8}>
                  <Skeleton className="h-8 w-full" />
                </TableCell>
              </TableRow>
            )}
            {!isLoading && orders.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                  No sales orders found
                </TableCell>
              </TableRow>
            )}
            {orders.map((so) => (
              <TableRow
                key={so.id ?? 0}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => setDetailId(so.id ?? null)}
              >
                <TableCell className="font-mono text-sm">{so.code ?? ""}</TableCell>
                <TableCell>{so.customerName ?? "—"}</TableCell>
                <TableCell>{fmtDate(so.requestedDate)}</TableCell>
                <TableCell>
                  <StatusBadge status={so.status} />
                </TableCell>
                <TableCell className="text-right font-medium">${fmt(so.total)}</TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {fmtDate(so.createdAt)}
                </TableCell>
                <TableCell className="max-w-[200px]">
                  {so.notes?.trim() ? (
                    <span className="block truncate text-xs text-muted-foreground" title={so.notes}>
                      {so.notes}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setDetailId(so.id ?? null)}>
                        View Details
                      </DropdownMenuItem>
                      {so.status === "draft" && (
                        <DropdownMenuItem onClick={() => handleConfirm(so.id!)}>
                          <CheckCircle2 className="w-4 h-4 mr-2" /> Confirm & Allocate
                        </DropdownMenuItem>
                      )}
                      {!["cancelled", "invoiced", "despatched"].includes(so.status ?? "") && (
                        <DropdownMenuItem
                          className="text-orange-600"
                          onClick={() => handleCancel(so.id!)}
                        >
                          <XCircle className="w-4 h-4 mr-2" /> Cancel
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      {["draft", "cancelled"].includes(so.status ?? "") && (
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => handleDelete(so.id!)}
                        >
                          Delete
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Create Dialog */}
      <Dialog
        open={showCreate}
        onOpenChange={(v) => {
          setShowCreate(v);
          if (!v) form.reset({ lines: [] });
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Sales Order</DialogTitle>
            <DialogDescription>Create a new sales order for a customer.</DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onCreate)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Customer</Label>
                <Controller
                  control={form.control}
                  name="customerId"
                  render={({ field: f }) => (
                    <Select
                      value={f.value ? String(f.value) : ""}
                      onValueChange={(v) => {
                        f.onChange(v ? Number(v) : undefined);
                        const c = custList.find((c) => c.id === Number(v));
                        if (c) {
                          form.setValue("customerName", c.name);
                          form.setValue("customerEmail", c.email ?? undefined);
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select customer..." />
                      </SelectTrigger>
                      <SelectContent>
                        {custList.map((c) => (
                          <SelectItem key={c.id ?? 0} value={String(c.id)}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div>
                <Label>Warehouse</Label>
                <Controller
                  control={form.control}
                  name="warehouseId"
                  render={({ field: f }) => (
                    <Select
                      value={f.value ? String(f.value) : ""}
                      onValueChange={(v) => f.onChange(v ? Number(v) : undefined)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select warehouse..." />
                      </SelectTrigger>
                      <SelectContent>
                        {warehouseList.map((w) => (
                          <SelectItem key={w.id ?? 0} value={String(w.id)}>
                            {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div>
                <Label>Requested Date</Label>
                <Input {...form.register("requestedDate")} type="date" />
              </div>
              <div>
                <Label>Payment Terms</Label>
                <Input {...form.register("paymentTerms")} placeholder="Net 30" />
              </div>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea {...form.register("notes")} placeholder="Notes..." rows={2} />
            </div>
            <LineItemEditor
              fields={fields as LineField[]}
              control={form.control as unknown as Control<LineEditorFormBase>}
              items={itemsList}
              onAdd={() => append({ quantity: 1, unitPrice: 0, discountPct: 0, taxPct: 10 })}
              onRemove={remove}
              setValue={(idx, patch) => {
                if (patch.description !== undefined) form.setValue(`lines.${idx}.description`, patch.description);
                if (patch.unitPrice !== undefined) form.setValue(`lines.${idx}.unitPrice`, patch.unitPrice);
              }}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMut.isPending}>
                {createMut.isPending ? "Creating..." : "Create Order"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Detail Dialog */}
      <Dialog open={detailId !== null} onOpenChange={(v) => { if (!v) setDetailId(null); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{det?.code ?? "Sales Order"}</DialogTitle>
            <DialogDescription>
              {det?.customerName ?? ""}{" "}
              {det?.status && <StatusBadge status={det.status} />}
            </DialogDescription>
          </DialogHeader>
          {det && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Requested:</span>{" "}
                  {fmtDate(det.requestedDate)}
                </div>
                <div>
                  <span className="text-muted-foreground">Payment:</span>{" "}
                  {det.paymentTerms ?? "—"}
                </div>
                <div>
                  <span className="text-muted-foreground">Currency:</span>{" "}
                  {det.currencyCode}
                </div>
              </div>
              <div className="text-sm">
                <span className="text-muted-foreground">Notes:</span>{" "}
                {det.notes?.trim() ? (
                  <span className="whitespace-pre-wrap">{det.notes}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>#</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Despatched</TableHead>
                    <TableHead className="text-right">Unit Price</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {det.lines?.map((l) => (
                    <TableRow key={l.id ?? 0}>
                      <TableCell className="text-xs">{l.lineNumber}</TableCell>
                      <TableCell className="text-xs">
                        {l.itemCode
                          ? `${l.itemCode} – ${l.itemName}`
                          : l.description ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs text-right">
                        {fmt(l.quantity, 0)}
                      </TableCell>
                      <TableCell className="text-xs text-right text-blue-600">
                        {fmt(l.despatched_qty, 0)}
                      </TableCell>
                      <TableCell className="text-xs text-right">
                        ${fmt(l.unitPrice)}
                      </TableCell>
                      <TableCell className="text-xs text-right font-medium">
                        ${fmt(l.lineTotal)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex justify-end text-sm font-medium">
                Total: ${fmt(det.total)}
              </div>
              <div className="flex gap-2 justify-end flex-wrap">
                {det.status === "draft" && (
                  <Button size="sm" onClick={() => handleConfirm(detailId!)}>
                    <CheckCircle2 className="w-3 h-3 mr-1" /> Confirm
                  </Button>
                )}
                {["confirmed", "picking", "partially_despatched"].includes(det.status ?? "") && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openDespatch(detailId!)}
                  >
                    <Truck className="w-3 h-3 mr-1" /> Create Despatch
                  </Button>
                )}
                {!["cancelled", "invoiced", "despatched"].includes(det.status ?? "") && (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => handleCancel(detailId!)}
                  >
                    <XCircle className="w-3 h-3 mr-1" /> Cancel
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Despatch Dialog */}
      <Dialog
        open={showDespatch !== null}
        onOpenChange={(v) => {
          if (!v) setShowDespatch(null);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create Despatch</DialogTitle>
            <DialogDescription>Despatch goods for this sales order</DialogDescription>
          </DialogHeader>
          <form onSubmit={despatchForm.handleSubmit(onDespatch)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Tracking Number</Label>
                <Input
                  {...despatchForm.register("trackingNumber")}
                  placeholder="Optional"
                />
              </div>
              <div>
                <Label>Carrier</Label>
                <Input
                  {...despatchForm.register("carrier")}
                  placeholder="DHL, FedEx, etc."
                />
              </div>
              <div>
                <Label>Despatch Date</Label>
                <Input {...despatchForm.register("despatchDate")} type="date" />
              </div>
            </div>
            <div className="border rounded-md overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right w-24">Qty</TableHead>
                    <TableHead className="text-right w-28">Unit Price</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {despatchFields.map((field, idx) => (
                    <TableRow key={field.id ?? 0}>
                      <TableCell className="text-xs">
                        <Controller
                          control={despatchForm.control}
                          name={`lines.${idx}.itemCode`}
                          render={({ field: f }) => (
                            <span className="font-mono">{f.value ?? "—"}</span>
                          )}
                        />
                        {" "}
                        <Controller
                          control={despatchForm.control}
                          name={`lines.${idx}.itemName`}
                          render={({ field: f }) => (
                            <span className="text-muted-foreground">{f.value}</span>
                          )}
                        />
                      </TableCell>
                      <TableCell className="p-1">
                        <Controller
                          control={despatchForm.control}
                          name={`lines.${idx}.quantity`}
                          render={({ field: f }) => (
                            <Input
                              {...f}
                              type="number"
                              min="0"
                              step="1"
                              className="h-7 text-xs w-20 ml-auto"
                            />
                          )}
                        />
                      </TableCell>
                      <TableCell className="p-1">
                        <Controller
                          control={despatchForm.control}
                          name={`lines.${idx}.unitPrice`}
                          render={({ field: f }) => (
                            <Input
                              {...f}
                              type="number"
                              min="0"
                              step="0.01"
                              className="h-7 text-xs w-24 ml-auto"
                            />
                          )}
                        />
                      </TableCell>
                      <TableCell className="p-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => removeDespatch(idx)}
                        >
                          <XCircle className="w-4 h-4 text-muted-foreground" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {despatchFields.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="text-center text-muted-foreground text-xs py-4"
                      >
                        No lines to despatch
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowDespatch(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createDespatchMut.isPending}>
                {createDespatchMut.isPending ? "Creating..." : "Create Despatch"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Despatches Tab ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function DespatchesTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data: list, isLoading } = useListDespatches({
    status: statusFilter !== "all" ? statusFilter : undefined,
    limit: 50,
  });
  const { data: detail } = useGetDespatch(detailId!, {
    query: {
      enabled: detailId !== null,
      queryKey: getGetDespatchQueryKey(detailId!),
    },
  });
  const confirmMut = useConfirmDespatch();
  const cancelDespMut = useCancelDespatch();

  async function handleConfirm(id: number) {
    try {
      await confirmMut.mutateAsync({ id });
      toast({ title: "Despatch confirmed — inventory and GL posted" });
      qc.invalidateQueries({ queryKey: getListDespatchesQueryKey() });
      qc.invalidateQueries({ queryKey: getGetDespatchQueryKey(id) });
      qc.invalidateQueries({ queryKey: getListSalesOrdersQueryKey() });
    } catch {
      toast({ title: "Failed to confirm despatch", variant: "destructive" });
    }
  }

  async function handleCancelDesp(id: number) {
    try {
      await cancelDespMut.mutateAsync({ id });
      toast({ title: "Despatch cancelled" });
      qc.invalidateQueries({ queryKey: getListDespatchesQueryKey() });
    } catch {
      toast({ title: "Failed to cancel despatch", variant: "destructive" });
    }
  }

  const despatches = (list as { data?: Despatch[] })?.data ?? [];
  const det = detail as DespatchDetail | undefined;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="confirmed">Confirmed</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => qc.invalidateQueries({ queryKey: getListDespatchesQueryKey() })}
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>
      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Sales Order</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Carrier</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={7}>
                  <Skeleton className="h-8 w-full" />
                </TableCell>
              </TableRow>
            )}
            {!isLoading && despatches.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                  No despatches found
                </TableCell>
              </TableRow>
            )}
            {despatches.map((d) => (
              <TableRow
                key={d.id ?? 0}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => setDetailId(d.id ?? null)}
              >
                <TableCell className="font-mono text-sm">{d.code ?? ""}</TableCell>
                <TableCell className="text-xs font-mono">
                  SO-{String(d.soId).padStart(6, "0")}
                </TableCell>
                <TableCell>{fmtDate(d.despatchDate)}</TableCell>
                <TableCell>{d.carrier ?? "—"}</TableCell>
                <TableCell>
                  <StatusBadge status={d.status} />
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {fmtDate(d.createdAt)}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()} className="space-x-1">
                  {d.status === "draft" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleConfirm(d.id!)}
                      disabled={confirmMut.isPending}
                    >
                      <CheckCircle2 className="w-3 h-3 mr-1" /> Confirm
                    </Button>
                  )}
                  {d.status === "confirmed" && (
                    <Button
                      size="sm"
                      variant="outline"
                      asChild
                    >
                      <a href={`/forge-erp-api/api/sales/despatches/${d.id}/pdf`} target="_blank" rel="noreferrer">
                        <Printer className="w-3 h-3 mr-1" /> Delivery Docket
                      </a>
                    </Button>
                  )}
                  {d.status === "draft" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-600 hover:text-red-700"
                      onClick={() => handleCancelDesp(d.id!)}
                      disabled={cancelDespMut.isPending}
                    >
                      Cancel
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Detail Dialog */}
      <Dialog open={detailId !== null} onOpenChange={(v) => { if (!v) setDetailId(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{det?.code ?? "Despatch"}</DialogTitle>
            <DialogDescription>
              {det?.status && <StatusBadge status={det.status} />}
              {det?.trackingNumber && ` · ${det.trackingNumber}`}
            </DialogDescription>
          </DialogHeader>
          {det && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Date:</span>{" "}
                  {fmtDate(det.despatchDate)}
                </div>
                <div>
                  <span className="text-muted-foreground">Carrier:</span>{" "}
                  {det.carrier ?? "—"}
                </div>
                <div>
                  <span className="text-muted-foreground">GL:</span>{" "}
                  {det.glPostingId ? `#${det.glPostingId}` : "None"}
                </div>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Unit Price</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {det.lines?.map((l) => (
                    <TableRow key={l.id ?? 0}>
                      <TableCell className="text-xs">
                        {l.itemCode ? `${l.itemCode} – ${l.itemName}` : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-right">
                        {fmt(l.quantity, 0)}
                      </TableCell>
                      <TableCell className="text-xs text-right">
                        ${fmt(l.unitPrice)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {det.status === "draft" && (
                <div className="flex justify-end">
                  <Button
                    onClick={() => handleConfirm(detailId!)}
                    disabled={confirmMut.isPending}
                  >
                    <CheckCircle2 className="w-4 h-4 mr-1" /> Confirm Despatch
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Invoices Tab ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

type InvLineForm = {
  soLineId?: number;
  description?: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxPct: number;
};
type InvForm = {
  soId?: number;
  invoiceDate?: string;
  dueDate?: string;
  notes?: string;
  lines: InvLineForm[];
};

function InvoicesTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data: list, isLoading } = useListCustomerInvoices({
    status: statusFilter !== "all" ? statusFilter : undefined,
    limit: 50,
  });
  const { data: detail } = useGetCustomerInvoice(detailId!, {
    query: {
      enabled: detailId !== null,
      queryKey: getListCustomerInvoicesQueryKey(),
    },
  });
  const { data: orderList } = useListSalesOrders({ limit: 200 });

  const createMut = useCreateCustomerInvoice();
  const sendMut = useSendCustomerInvoice();
  const voidMut = useVoidInvoice();

  async function handleVoidInvoice(id: number) {
    try {
      await voidMut.mutateAsync({ id });
      toast({ title: "Invoice voided" });
      qc.invalidateQueries({ queryKey: getListCustomerInvoicesQueryKey() });
      if (detailId === id) setDetailId(null);
    } catch {
      toast({ title: "Failed to void invoice", variant: "destructive" });
    }
  }

  const form = useForm<InvForm>({ defaultValues: { lines: [] } });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "lines" });

  const selectedSoId = form.watch("soId");
  const { data: selectedSo } = useGetSalesOrder(selectedSoId!, {
    query: {
      enabled: selectedSoId !== undefined,
      queryKey: getGetSalesOrderQueryKey(selectedSoId!),
    },
  });

  const invoices = (list as { data?: CustomerInvoice[] })?.data ?? [];
  const orders = (orderList as { data?: SalesOrder[] })?.data ?? [];
  const det = detail as CustomerInvoiceDetail | undefined;

  function onSoChange() {
    const soDetail = selectedSo as SalesOrderDetail | undefined;
    if (!soDetail?.lines) return;
    const lines: InvLineForm[] = soDetail.lines
      .filter((l) => l.lineType === "stock")
      .map((l) => ({
        soLineId: l.id,
        description: `${l.itemCode ?? ""} – ${l.itemName ?? ""}`,
        quantity: Number(l.quantity) - Number(l.invoiced_qty ?? 0),
        unitPrice: Number(l.unitPrice),
        discountPct: Number(l.discountPct ?? 0),
        taxPct: Number(l.taxPct ?? 0),
      }));
    form.setValue("lines", lines);
  }

  async function onSubmit(values: InvForm) {
    try {
      await createMut.mutateAsync({
        data: {
          soId: values.soId!,
          invoiceDate: values.invoiceDate,
          dueDate: values.dueDate,
          notes: values.notes,
          lines: values.lines.map((l) => ({
            soLineId: l.soLineId,
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            discountPct: l.discountPct,
            taxPct: l.taxPct,
          })),
        },
      });
      toast({ title: "Invoice created" });
      setShowCreate(false);
      form.reset({ lines: [] });
      qc.invalidateQueries({ queryKey: getListCustomerInvoicesQueryKey() });
    } catch {
      toast({ title: "Failed to create invoice", variant: "destructive" });
    }
  }

  async function handleSend(id: number) {
    try {
      await sendMut.mutateAsync({ id, data: {} });
      toast({ title: "Invoice sent to customer" });
      qc.invalidateQueries({ queryKey: getListCustomerInvoicesQueryKey() });
    } catch {
      toast({ title: "Failed to send invoice", variant: "destructive" });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="sent">Sent</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-1" /> New Invoice
        </Button>
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Invoice Date</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Notes</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={8}>
                  <Skeleton className="h-8 w-full" />
                </TableCell>
              </TableRow>
            )}
            {!isLoading && invoices.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                  No invoices found
                </TableCell>
              </TableRow>
            )}
            {invoices.map((inv) => (
              <TableRow
                key={inv.id ?? 0}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => setDetailId(inv.id ?? null)}
              >
                <TableCell className="font-mono text-sm">{inv.code ?? ""}</TableCell>
                <TableCell>{inv.customerName ?? "—"}</TableCell>
                <TableCell>{fmtDate(inv.invoiceDate)}</TableCell>
                <TableCell>{fmtDate(inv.dueDate)}</TableCell>
                <TableCell>
                  <StatusBadge status={inv.status} />
                </TableCell>
                <TableCell className="text-right font-medium">${fmt(inv.total)}</TableCell>
                <TableCell className="max-w-[200px]">
                  {inv.notes?.trim() ? (
                    <span className="block truncate text-xs text-muted-foreground" title={inv.notes}>
                      {inv.notes}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()} className="space-x-1">
                  {["draft", "sent"].includes(inv.status ?? "") && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleSend(inv.id!)}
                    >
                      <Send className="w-3 h-3 mr-1" /> Send
                    </Button>
                  )}
                  {inv.status === "draft" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-600 hover:text-red-700"
                      onClick={() => handleVoidInvoice(inv.id!)}
                      disabled={voidMut.isPending}
                    >
                      Void
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Create Dialog */}
      <Dialog
        open={showCreate}
        onOpenChange={(v) => {
          setShowCreate(v);
          if (!v) form.reset({ lines: [] });
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Customer Invoice</DialogTitle>
            <DialogDescription>Create an invoice for a despatched sales order.</DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Sales Order</Label>
                <Controller
                  control={form.control}
                  name="soId"
                  render={({ field: f }) => (
                    <Select
                      value={f.value ? String(f.value) : ""}
                      onValueChange={(v) => {
                        f.onChange(v ? Number(v) : undefined);
                        setTimeout(onSoChange, 200);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select order..." />
                      </SelectTrigger>
                      <SelectContent>
                        {orders
                          .filter((o) =>
                            ["despatched", "partially_despatched", "confirmed"].includes(
                              o.status ?? ""
                            )
                          )
                          .map((o) => (
                            <SelectItem key={o.id ?? 0} value={String(o.id ?? 0)}>
                              {o.code ?? ""} – {o.customerName}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div>
                <Label>Invoice Date</Label>
                <Input {...form.register("invoiceDate")} type="date" />
              </div>
              <div>
                <Label>Due Date</Label>
                <Input {...form.register("dueDate")} type="date" />
              </div>
            </div>
            <div className="border rounded-md overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead>Description</TableHead>
                    <TableHead className="w-20">Qty</TableHead>
                    <TableHead className="w-24">Unit Price</TableHead>
                    <TableHead className="w-16">Tax%</TableHead>
                    <TableHead className="w-8" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {fields.map((field, idx) => (
                    <TableRow key={field.id ?? 0}>
                      <TableCell className="p-1">
                        <Controller
                          control={form.control}
                          name={`lines.${idx}.description`}
                          render={({ field: f }) => (
                            <Input
                              {...f}
                              value={f.value ?? ""}
                              className="h-7 text-xs"
                              placeholder="Description"
                            />
                          )}
                        />
                      </TableCell>
                      <TableCell className="p-1">
                        <Controller
                          control={form.control}
                          name={`lines.${idx}.quantity`}
                          render={({ field: f }) => (
                            <Input
                              {...f}
                              type="number"
                              min="0"
                              step="1"
                              className="h-7 text-xs w-16"
                            />
                          )}
                        />
                      </TableCell>
                      <TableCell className="p-1">
                        <Controller
                          control={form.control}
                          name={`lines.${idx}.unitPrice`}
                          render={({ field: f }) => (
                            <Input
                              {...f}
                              type="number"
                              min="0"
                              step="0.01"
                              className="h-7 text-xs w-20"
                            />
                          )}
                        />
                      </TableCell>
                      <TableCell className="p-1">
                        <Controller
                          control={form.control}
                          name={`lines.${idx}.taxPct`}
                          render={({ field: f }) => (
                            <Input
                              {...f}
                              type="number"
                              min="0"
                              max="100"
                              step="0.01"
                              className="h-7 text-xs w-16"
                            />
                          )}
                        />
                      </TableCell>
                      <TableCell className="p-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => remove(idx)}
                        >
                          <XCircle className="w-4 h-4 text-muted-foreground" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {fields.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="text-center text-muted-foreground text-xs py-4"
                      >
                        Select a Sales Order to auto-populate, or add lines manually.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => append({ quantity: 1, unitPrice: 0, discountPct: 0, taxPct: 0 })}
            >
              <Plus className="w-3 h-3 mr-1" /> Add Line
            </Button>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMut.isPending}>
                {createMut.isPending ? "Creating..." : "Create Invoice"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Detail Dialog */}
      <Dialog open={detailId !== null} onOpenChange={(v) => { if (!v) setDetailId(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{det?.code ?? "Invoice"}</DialogTitle>
            <DialogDescription>
              {det?.status && <StatusBadge status={det.status} />}
            </DialogDescription>
          </DialogHeader>
          {det && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Customer:</span>{" "}
                  {det.customerName ?? "—"}
                </div>
                <div>
                  <span className="text-muted-foreground">Date:</span>{" "}
                  {fmtDate(det.invoiceDate)}
                </div>
                <div>
                  <span className="text-muted-foreground">Due:</span>{" "}
                  {fmtDate(det.dueDate)}
                </div>
              </div>
              <div className="text-sm">
                <span className="text-muted-foreground">Notes:</span>{" "}
                {det.notes?.trim() ? (
                  <span className="whitespace-pre-wrap">{det.notes}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item / Description</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Unit Price</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {det.lines?.map((l) => (
                    <TableRow key={l.id ?? 0}>
                      <TableCell className="text-xs">
                        {l.itemCode
                          ? `${l.itemCode} – ${l.itemName}`
                          : l.description ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs text-right">
                        {fmt(l.quantity, 0)}
                      </TableCell>
                      <TableCell className="text-xs text-right">
                        ${fmt(l.unitPrice)}
                      </TableCell>
                      <TableCell className="text-xs text-right font-medium">
                        ${fmt(l.lineTotal)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex justify-between items-center">
                <span className="text-sm font-medium">Total: ${fmt(det.total)}</span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => window.open(`/forge-erp-api/api/sales/invoices/${detailId}/pdf`, "_blank")}
                  >
                    <Printer className="w-3 h-3 mr-1" /> Print Invoice
                  </Button>
                  {["draft", "sent"].includes(det.status ?? "") && (
                    <Button size="sm" onClick={() => handleSend(detailId!)}>
                      <Send className="w-3 h-3 mr-1" /> Send Invoice
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── RMA Tab ───────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

type RmaLineForm = {
  itemCode?: string;
  itemName?: string;
  quantity: number;
  condition: "good" | "damaged" | "unknown";
  disposition: "restock" | "scrap" | "return_to_supplier";
};
type RmaForm = {
  customerId?: number;
  customerName?: string;
  customerEmail?: string;
  reason?: string;
  resolution: "credit" | "exchange" | "repair";
  notes?: string;
  lines: RmaLineForm[];
};

function RmaTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data: list, isLoading } = useListRmaOrders({
    status: statusFilter !== "all" ? statusFilter : undefined,
    limit: 50,
  });
  const { data: detail } = useGetRmaOrder(detailId!, {
    query: {
      enabled: detailId !== null,
      queryKey: getListRmaOrdersQueryKey(),
    },
  });
  const { data: customers } = useListCustomers({ limit: 200 });

  const createMut = useCreateRmaOrder();
  const authorizeMut = useAuthorizeRma();
  const receiveMut = useReceiveRma();
  const processMut = useProcessRma();
  const cancelRmaMut = useCancelRma();

  async function handleCancelRma(id: number) {
    try {
      await cancelRmaMut.mutateAsync({ id });
      toast({ title: "RMA cancelled" });
      invalidate();
      if (detailId === id) setDetailId(null);
    } catch {
      toast({ title: "Failed to cancel RMA", variant: "destructive" });
    }
  }

  const form = useForm<RmaForm>({
    defaultValues: { resolution: "credit", lines: [] },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "lines" });

  const custList =
    (customers as { customers?: Array<{
      id: number;
      code?: string | null;
      name: string;
      email?: string | null;
      shippingAddressLine1?: string | null;
      shippingAddressLine2?: string | null;
      shippingCity?: string | null;
      shippingState?: string | null;
      shippingPostalCode?: string | null;
      shippingCountry?: string | null;
    }> })?.customers ?? [];
  const rmaOrders = (list as { data?: RmaOrder[] })?.data ?? [];
  const det = detail as RmaDetail | undefined;

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListRmaOrdersQueryKey() });

  async function onSubmit(values: RmaForm) {
    try {
      await createMut.mutateAsync({
        data: {
          customerId: values.customerId,
          customerName: values.customerName,
          customerEmail: values.customerEmail,
          reason: values.reason,
          resolution: values.resolution,
          notes: values.notes,
          lines: values.lines.map((l) => ({
            itemCode: l.itemCode,
            itemName: l.itemName,
            quantity: l.quantity,
            condition: l.condition,
            disposition: l.disposition,
          })),
        },
      });
      toast({ title: "RMA created" });
      setShowCreate(false);
      form.reset({ resolution: "credit", lines: [] });
      invalidate();
    } catch {
      toast({ title: "Failed to create RMA", variant: "destructive" });
    }
  }

  async function handleAuthorize(id: number) {
    try {
      await authorizeMut.mutateAsync({ id });
      toast({ title: "RMA authorized" });
      invalidate();
    } catch {
      toast({ title: "Failed to authorize", variant: "destructive" });
    }
  }

  async function handleReceive(id: number) {
    try {
      await receiveMut.mutateAsync({ id, data: { lines: [] } });
      toast({ title: "RMA received" });
      invalidate();
    } catch {
      toast({ title: "Failed to mark received", variant: "destructive" });
    }
  }

  async function handleProcess(id: number) {
    try {
      await processMut.mutateAsync({ id });
      toast({ title: "RMA processed" });
      invalidate();
    } catch {
      toast({ title: "Failed to process", variant: "destructive" });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="authorized">Authorized</SelectItem>
            <SelectItem value="received">Received</SelectItem>
            <SelectItem value="processed">Processed</SelectItem>
            <SelectItem value="closed">Closed</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-1" /> New RMA
        </Button>
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Resolution</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={6}>
                  <Skeleton className="h-8 w-full" />
                </TableCell>
              </TableRow>
            )}
            {!isLoading && rmaOrders.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                  No RMA orders found
                </TableCell>
              </TableRow>
            )}
            {rmaOrders.map((rma) => (
              <TableRow
                key={rma.id ?? 0}
                className="cursor-pointer hover:bg-muted/50"
                onClick={() => setDetailId(rma.id ?? null)}
              >
                <TableCell className="font-mono text-sm">{rma.code ?? ""}</TableCell>
                <TableCell>{rma.customerName ?? "—"}</TableCell>
                <TableCell className="capitalize">{rma.resolution}</TableCell>
                <TableCell>
                  <StatusBadge status={rma.status} />
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {fmtDate(rma.createdAt)}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setDetailId(rma.id ?? null)}>
                        View Details
                      </DropdownMenuItem>
                      {rma.status === "draft" && (
                        <DropdownMenuItem onClick={() => handleAuthorize(rma.id!)}>
                          Authorize
                        </DropdownMenuItem>
                      )}
                      {rma.status === "authorized" && (
                        <DropdownMenuItem onClick={() => handleReceive(rma.id!)}>
                          Mark Received
                        </DropdownMenuItem>
                      )}
                      {rma.status === "received" && (
                        <DropdownMenuItem onClick={() => handleProcess(rma.id!)}>
                          Mark Processed
                        </DropdownMenuItem>
                      )}
                      {!["received", "processed", "closed", "cancelled"].includes(rma.status ?? "") && (
                        <DropdownMenuItem
                          className="text-red-600"
                          onClick={() => handleCancelRma(rma.id!)}
                        >
                          Cancel RMA
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Create Dialog */}
      <Dialog
        open={showCreate}
        onOpenChange={(v) => {
          setShowCreate(v);
          if (!v) form.reset({ resolution: "credit", lines: [] });
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New RMA Order</DialogTitle>
            <DialogDescription>
              Create a return merchandise authorization for a customer.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Customer</Label>
                <Controller
                  control={form.control}
                  name="customerId"
                  render={({ field: f }) => (
                    <Select
                      value={f.value ? String(f.value) : ""}
                      onValueChange={(v) => {
                        f.onChange(v ? Number(v) : undefined);
                        const c = custList.find((c) => c.id === Number(v));
                        if (c) {
                          form.setValue("customerName", c.name);
                          form.setValue("customerEmail", c.email ?? undefined);
                        }
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select customer..." />
                      </SelectTrigger>
                      <SelectContent>
                        {custList.map((c) => (
                          <SelectItem key={c.id ?? 0} value={String(c.id)}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div>
                <Label>Resolution</Label>
                <Controller
                  control={form.control}
                  name="resolution"
                  render={({ field: f }) => (
                    <Select value={f.value} onValueChange={f.onChange}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="credit">Credit</SelectItem>
                        <SelectItem value="exchange">Exchange</SelectItem>
                        <SelectItem value="repair">Repair</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
              <div>
                <Label>Reason</Label>
                <Input
                  {...form.register("reason")}
                  placeholder="e.g. Defective, Wrong item..."
                />
              </div>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea {...form.register("notes")} rows={2} />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Return Lines</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    append({ quantity: 1, condition: "unknown", disposition: "restock" })
                  }
                >
                  <Plus className="w-3 h-3 mr-1" /> Add Line
                </Button>
              </div>
              <div className="border rounded-md overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead>Item Code</TableHead>
                      <TableHead>Item Name</TableHead>
                      <TableHead className="w-20">Qty</TableHead>
                      <TableHead className="w-28">Condition</TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((field, idx) => (
                      <TableRow key={field.id ?? 0}>
                        <TableCell className="p-1">
                          <Controller
                            control={form.control}
                            name={`lines.${idx}.itemCode`}
                            render={({ field: f }) => (
                              <Input
                                {...f}
                                value={f.value ?? ""}
                                className="h-7 text-xs"
                                placeholder="Code"
                              />
                            )}
                          />
                        </TableCell>
                        <TableCell className="p-1">
                          <Controller
                            control={form.control}
                            name={`lines.${idx}.itemName`}
                            render={({ field: f }) => (
                              <Input
                                {...f}
                                value={f.value ?? ""}
                                className="h-7 text-xs"
                                placeholder="Name"
                              />
                            )}
                          />
                        </TableCell>
                        <TableCell className="p-1">
                          <Controller
                            control={form.control}
                            name={`lines.${idx}.quantity`}
                            render={({ field: f }) => (
                              <Input
                                {...f}
                                type="number"
                                min="1"
                                step="1"
                                className="h-7 text-xs w-16"
                              />
                            )}
                          />
                        </TableCell>
                        <TableCell className="p-1">
                          <Controller
                            control={form.control}
                            name={`lines.${idx}.condition`}
                            render={({ field: f }) => (
                              <Select value={f.value} onValueChange={f.onChange}>
                                <SelectTrigger className="h-7 text-xs">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="good">Good</SelectItem>
                                  <SelectItem value="damaged">Damaged</SelectItem>
                                  <SelectItem value="unknown">Unknown</SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                          />
                        </TableCell>
                        <TableCell className="p-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => remove(idx)}
                          >
                            <XCircle className="w-4 h-4 text-muted-foreground" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {fields.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="text-center text-muted-foreground text-xs py-4"
                        >
                          Add return lines above
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMut.isPending}>
                {createMut.isPending ? "Creating..." : "Create RMA"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Detail Dialog */}
      <Dialog open={detailId !== null} onOpenChange={(v) => { if (!v) setDetailId(null); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{det?.code ?? "RMA"}</DialogTitle>
            <DialogDescription>
              {det?.customerName ?? ""}{" "}
              {det?.status && <StatusBadge status={det.status} />}
            </DialogDescription>
          </DialogHeader>
          {det && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">Resolution:</span>{" "}
                  {det.resolution}
                </div>
                <div>
                  <span className="text-muted-foreground">Reason:</span>{" "}
                  {det.reason ?? "—"}
                </div>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Received</TableHead>
                    <TableHead>Condition</TableHead>
                    <TableHead>Disposition</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {det.lines?.map((l) => (
                    <TableRow key={l.id ?? 0}>
                      <TableCell className="text-xs">
                        {l.itemCode ? `${l.itemCode} – ${l.itemName}` : "—"}
                      </TableCell>
                      <TableCell className="text-xs text-right">
                        {fmt(l.quantity, 0)}
                      </TableCell>
                      <TableCell className="text-xs text-right">
                        {fmt(l.receivedQty, 0)}
                      </TableCell>
                      <TableCell className="text-xs capitalize">{l.condition}</TableCell>
                      <TableCell className="text-xs capitalize">{l.disposition}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex gap-2 justify-end">
                {det.status === "draft" && (
                  <Button size="sm" onClick={() => handleAuthorize(detailId!)}>
                    Authorize
                  </Button>
                )}
                {det.status === "authorized" && (
                  <Button size="sm" onClick={() => handleReceive(detailId!)}>
                    Mark Received
                  </Button>
                )}
                {det.status === "received" && (
                  <Button size="sm" onClick={() => handleProcess(detailId!)}>
                    Process
                  </Button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Credit Notes Tab ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

type CnLineForm = {
  description?: string;
  quantity: number;
  unitPrice: number;
  taxPct: number;
};
type CnForm = {
  customerName?: string;
  reason?: string;
  notes?: string;
  lines: CnLineForm[];
};

function CreditNotesTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");
  const [showCreate, setShowCreate] = useState(false);

  const { data: list, isLoading } = useListCreditNotes({
    status: statusFilter !== "all" ? statusFilter : undefined,
    limit: 50,
  });
  const createMut = useCreateCreditNote();
  const issueMut = useIssueCreditNote();

  const form = useForm<CnForm>({ defaultValues: { lines: [] } });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "lines" });

  const creditNotes = (list as { data?: CreditNote[] })?.data ?? [];

  async function onSubmit(values: CnForm) {
    try {
      await createMut.mutateAsync({
        data: {
          customerName: values.customerName,
          reason: values.reason,
          notes: values.notes,
          lines: values.lines.map((l) => ({
            description: l.description,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            taxPct: l.taxPct,
          })),
        },
      });
      toast({ title: "Credit note created" });
      setShowCreate(false);
      form.reset({ lines: [] });
      qc.invalidateQueries({ queryKey: getListCreditNotesQueryKey() });
    } catch {
      toast({ title: "Failed to create credit note", variant: "destructive" });
    }
  }

  async function handleIssue(id: number) {
    try {
      await issueMut.mutateAsync({ id });
      toast({ title: "Credit note issued and GL posted" });
      qc.invalidateQueries({ queryKey: getListCreditNotesQueryKey() });
    } catch {
      toast({ title: "Failed to issue credit note", variant: "destructive" });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="issued">Issued</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="w-4 h-4 mr-1" /> New Credit Note
        </Button>
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead>Issued</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={7}>
                  <Skeleton className="h-8 w-full" />
                </TableCell>
              </TableRow>
            )}
            {!isLoading && creditNotes.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                  No credit notes found
                </TableCell>
              </TableRow>
            )}
            {creditNotes.map((cn) => (
              <TableRow key={cn.id ?? 0}>
                <TableCell className="font-mono text-sm">{cn.code ?? ""}</TableCell>
                <TableCell>{cn.customerName ?? "—"}</TableCell>
                <TableCell className="text-xs">{cn.reason ?? "—"}</TableCell>
                <TableCell>
                  <StatusBadge status={cn.status} />
                </TableCell>
                <TableCell className="text-right font-medium">${fmt(cn.total)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {fmtDate(cn.issuedAt)}
                </TableCell>
                <TableCell>
                  {cn.status === "draft" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleIssue(cn.id!)}
                      disabled={issueMut.isPending}
                    >
                      Issue & Post GL
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Create Dialog */}
      <Dialog
        open={showCreate}
        onOpenChange={(v) => {
          setShowCreate(v);
          if (!v) form.reset({ lines: [] });
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Credit Note</DialogTitle>
            <DialogDescription>Create a credit note for a customer.</DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Customer Name</Label>
                <Input {...form.register("customerName")} placeholder="Customer..." />
              </div>
              <div>
                <Label>Reason</Label>
                <Input
                  {...form.register("reason")}
                  placeholder="e.g. Pricing error, Return credit..."
                />
              </div>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea {...form.register("notes")} rows={2} />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Credit Lines</Label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => append({ quantity: 1, unitPrice: 0, taxPct: 0 })}
                >
                  <Plus className="w-3 h-3 mr-1" /> Add Line
                </Button>
              </div>
              <div className="border rounded-md overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/50">
                      <TableHead>Description</TableHead>
                      <TableHead className="w-20">Qty</TableHead>
                      <TableHead className="w-24">Unit Price</TableHead>
                      <TableHead className="w-16">Tax%</TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((field, idx) => (
                      <TableRow key={field.id ?? 0}>
                        <TableCell className="p-1">
                          <Controller
                            control={form.control}
                            name={`lines.${idx}.description`}
                            render={({ field: f }) => (
                              <Input
                                {...f}
                                value={f.value ?? ""}
                                className="h-7 text-xs"
                                placeholder="Description"
                              />
                            )}
                          />
                        </TableCell>
                        <TableCell className="p-1">
                          <Controller
                            control={form.control}
                            name={`lines.${idx}.quantity`}
                            render={({ field: f }) => (
                              <Input
                                {...f}
                                type="number"
                                min="1"
                                step="1"
                                className="h-7 text-xs w-16"
                              />
                            )}
                          />
                        </TableCell>
                        <TableCell className="p-1">
                          <Controller
                            control={form.control}
                            name={`lines.${idx}.unitPrice`}
                            render={({ field: f }) => (
                              <Input
                                {...f}
                                type="number"
                                min="0"
                                step="0.01"
                                className="h-7 text-xs w-20"
                              />
                            )}
                          />
                        </TableCell>
                        <TableCell className="p-1">
                          <Controller
                            control={form.control}
                            name={`lines.${idx}.taxPct`}
                            render={({ field: f }) => (
                              <Input
                                {...f}
                                type="number"
                                min="0"
                                max="100"
                                step="0.01"
                                className="h-7 text-xs w-16"
                              />
                            )}
                          />
                        </TableCell>
                        <TableCell className="p-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => remove(idx)}
                          >
                            <XCircle className="w-4 h-4 text-muted-foreground" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    {fields.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={5}
                          className="text-center text-muted-foreground text-xs py-4"
                        >
                          Add credit lines above
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMut.isPending}>
                {createMut.isPending ? "Creating..." : "Create Credit Note"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Pick Slips Tab ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function PickSlipsTab() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("all");
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data: list, isLoading } = useListPickSlips({
    status: statusFilter !== "all" ? statusFilter : undefined,
    limit: 50,
  });
  const { data: detail } = useGetPickSlip(detailId!, {
    query: {
      enabled: detailId !== null,
      queryKey: getListPickSlipsQueryKey(),
    },
  });

  const pickSlips = (list as { data?: PickSlip[] })?.data ?? [];
  const det = detail as PickSlipDetail | undefined;

  return (
    <div className="space-y-4">
      <SupervisorPickBoard />
      <div className="flex items-center gap-2">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="picking">Picking</SelectItem>
            <SelectItem value="picked">Picked</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={() => qc.invalidateQueries({ queryKey: getListPickSlipsQueryKey() })}
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>

      <div className="border rounded-md">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Sales Order</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Picker</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Lines</TableHead>
              <TableHead>Short</TableHead>
              <TableHead>Created</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={9}>
                  <Skeleton className="h-8 w-full" />
                </TableCell>
              </TableRow>
            )}
            {!isLoading && pickSlips.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                  No pick slips found. They are auto-created when despatches are made.
                </TableCell>
              </TableRow>
            )}
            {pickSlips.map((ps) => {
              const total = ps.totalLines ?? 0;
              const confirmed = ps.confirmedLines ?? 0;
              const short = ps.shortLines ?? 0;
              const pct = total > 0 ? Math.round((confirmed / total) * 100) : 0;
              return (
                <TableRow
                  key={ps.id ?? 0}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() => setDetailId(ps.id ?? null)}
                  data-testid={`row-pickslip-${ps.id}`}
                >
                  <TableCell className="font-mono text-sm">{ps.code ?? ""}</TableCell>
                  <TableCell className="font-mono text-xs">
                    SO-{String(ps.soId).padStart(6, "0")}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={ps.status} />
                  </TableCell>
                  <TableCell className="text-xs" data-testid={`cell-picker-${ps.id}`}>
                    {ps.assignedToName ? (
                      <span className="inline-flex items-center gap-1">
                        <User className="w-3 h-3 text-muted-foreground" />
                        {ps.assignedToName}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">Unassigned</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground" data-testid={`cell-started-${ps.id}`}>
                    {ps.startedAt ? (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {fmtDateTime(ps.startedAt)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-xs" data-testid={`cell-lines-${ps.id}`}>
                    {total > 0 ? (
                      <div className="flex items-center gap-2 min-w-[80px]">
                        <span className="font-mono">{confirmed}/{total}</span>
                        <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                          <div
                            className={`h-full ${confirmed === total ? "bg-green-500" : "bg-blue-500"}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-xs" data-testid={`cell-short-${ps.id}`}>
                    {short > 0 ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">
                        <AlertTriangle className="w-3 h-3" />
                        {short}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">0</span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {fmtDate(ps.createdAt)}
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="sm" onClick={() => setDetailId(ps.id ?? null)}>
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* Detail Dialog */}
      <Dialog open={detailId !== null} onOpenChange={(v) => { if (!v) setDetailId(null); }}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span>{det?.code ?? "Pick Slip"}</span>
              {det?.status && <StatusBadge status={det.status} />}
            </DialogTitle>
            <DialogDescription>
              {det && (
                <span className="flex flex-wrap items-center gap-4 text-xs mt-1">
                  <span className="inline-flex items-center gap-1">
                    <User className="w-3 h-3" />
                    {det.assignedToName ?? "Unassigned"}
                  </span>
                  {det.startedAt && (
                    <span className="inline-flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Started {fmtDateTime(det.startedAt)}
                    </span>
                  )}
                  {det.completedAt && (
                    <span className="inline-flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" />
                      Completed {fmtDateTime(det.completedAt)}
                    </span>
                  )}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          {det && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Required</TableHead>
                  <TableHead className="text-right">Picked</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Lot / Serial</TableHead>
                  <TableHead>Photo</TableHead>
                  <TableHead>Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {det.lines?.map((l) => (
                  <TableRow key={l.id ?? 0} data-testid={`row-pickline-${l.id}`}>
                    <TableCell className="text-xs align-top">
                      {l.itemCode ? `${l.itemCode} – ${l.itemName}` : "—"}
                    </TableCell>
                    <TableCell className="text-xs align-top">
                      <PickLineStatusBadge status={l.confirmStatus} />
                      {l.confirmedByName && (
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          by {l.confirmedByName}
                        </div>
                      )}
                      {l.confirmedAt && (
                        <div className="text-[10px] text-muted-foreground">
                          {fmtDateTime(l.confirmedAt)}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-right align-top">
                      {fmt(l.requiredQty, 0)}
                    </TableCell>
                    <TableCell className="text-xs text-right align-top">
                      {fmt(l.pickedQty, 0)}
                    </TableCell>
                    <TableCell className="text-xs align-top">
                      {l.locationLabel ?? (l.locationId ? `Location #${l.locationId}` : "—")}
                    </TableCell>
                    <TableCell className="text-xs align-top">
                      {l.lotNumber || l.serialNumber || l.batchNumber ? (
                        <div className="space-y-0.5">
                          {l.lotNumber && <div>Lot: <span className="font-mono">{l.lotNumber}</span></div>}
                          {l.serialNumber && <div>SN: <span className="font-mono">{l.serialNumber}</span></div>}
                          {l.batchNumber && <div>Batch: <span className="font-mono">{l.batchNumber}</span></div>}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      {l.photoObjectPath ? (
                        <a
                          href={`/api/storage${l.photoObjectPath}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block"
                          data-testid={`link-photo-${l.id}`}
                        >
                          <img
                            src={`/api/storage${l.photoObjectPath}`}
                            alt={`Pick photo for line ${l.id}`}
                            className="w-12 h-12 object-cover rounded border hover:opacity-80"
                          />
                        </a>
                      ) : (
                        <span className="text-muted-foreground text-xs inline-flex items-center gap-1">
                          <ImageIcon className="w-3 h-3" />
                          —
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs align-top">
                      {l.confirmStatus === "short" && l.shortReason ? (
                        <div className="space-y-0.5">
                          <div className="inline-flex items-center gap-1 text-amber-700 font-medium">
                            <AlertTriangle className="w-3 h-3" />
                            {l.shortReason.replace(/_/g, " ")}
                          </div>
                          {l.shortNote && (
                            <div className="text-[10px] text-muted-foreground">{l.shortNote}</div>
                          )}
                        </div>
                      ) : l.notes ? (
                        <span className="text-muted-foreground">{l.notes}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PickLineStatusBadge({ status }: { status?: string | null }) {
  const s = status ?? "pending";
  const cls =
    s === "picked"
      ? "bg-green-100 text-green-700"
      : s === "short"
        ? "bg-amber-100 text-amber-700"
        : "bg-gray-100 text-gray-700";
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-medium capitalize ${cls}`}>
      {s}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Supervisor Pick Board (real-time progress for warehouse supervisors) ──────
// ═══════════════════════════════════════════════════════════════════════════════

function SupervisorPickBoard() {
  const qc = useQueryClient();
  // Poll every 10s so the board feels real-time without needing websockets.
  const { data, isLoading } = useGetPickProgress({
    query: {
      queryKey: getGetPickProgressQueryKey(),
      refetchInterval: 10_000,
    },
  });
  const progress = data as PickProgressResponse | undefined;
  const slips = progress?.slips ?? [];
  const inFlight = slips.filter((s) => s.status === "picking" || (s.status === "pending" && s.assignedToName));
  const pickerBaseUrl = `${(import.meta.env.BASE_URL || "/").replace(/\/$/, "")}/picking`;

  return (
    <Card className="border-dashed">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Picking floor</CardTitle>
            <CardDescription>Live status across the warehouse — refreshes every 10s.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => qc.invalidateQueries({ queryKey: getGetPickProgressQueryKey() })}
              data-testid="button-refresh-pick-board"
            >
              <RefreshCw className="w-4 h-4 mr-1" /> Refresh
            </Button>
            <Button
              size="sm"
              onClick={() => window.open(pickerBaseUrl, "_blank", "noopener")}
              data-testid="button-open-picker-pwa"
            >
              Open Picker app
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <KPI label="Unassigned" value={progress?.unassigned ?? 0} tone="amber" testId="kpi-unassigned" />
          <KPI label="In progress" value={progress?.inProgress ?? 0} tone="blue" testId="kpi-in-progress" />
          <KPI label="Completed today" value={progress?.completedToday ?? 0} tone="emerald" testId="kpi-completed-today" />
          <KPI label="Short-picked today" value={progress?.shortPickedToday ?? 0} tone="rose" testId="kpi-short-today" />
        </div>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : inFlight.length === 0 ? (
          <p className="text-sm text-muted-foreground">No slips currently in progress.</p>
        ) : (
          <div className="border rounded-md">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Slip</TableHead>
                  <TableHead>Picker</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead className="text-right">Lines</TableHead>
                  <TableHead className="text-right">Short</TableHead>
                  <TableHead>Started</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inFlight.map((s) => (
                  <TableRow key={s.id} data-testid={`row-progress-${s.id}`}>
                    <TableCell className="font-mono text-xs">{s.code}</TableCell>
                    <TableCell className="text-sm">{s.assignedToName ?? "—"}</TableCell>
                    <TableCell className="w-48">
                      <div className="flex items-center gap-2">
                        <div className="h-2 flex-1 rounded bg-slate-200">
                          <div
                            className="h-full rounded bg-emerald-600"
                            style={{ width: `${s.progressPct}%` }}
                          />
                        </div>
                        <span className="text-xs tabular-nums w-10 text-right">{s.progressPct}%</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {s.confirmedLines}/{s.totalLines}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {(s.shortLines ?? 0) > 0 ? <span className="text-amber-700 font-semibold">{s.shortLines}</span> : 0}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {s.startedAt ? fmtDate(s.startedAt) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function KPI({
  label,
  value,
  tone,
  testId,
}: {
  label: string;
  value: number;
  tone: "amber" | "blue" | "emerald" | "rose";
  testId: string;
}) {
  const map = {
    amber: "bg-amber-50 text-amber-900 border-amber-200",
    blue: "bg-blue-50 text-blue-900 border-blue-200",
    emerald: "bg-emerald-50 text-emerald-900 border-emerald-200",
    rose: "bg-rose-50 text-rose-900 border-rose-200",
  } as const;
  return (
    <div className={`rounded-md border p-3 ${map[tone]}`} data-testid={testId}>
      <div className="text-xs uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Backorders Tab ────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function BackordersTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("open");
  const { data: list, isLoading } = useListBackorders({ status: statusFilter !== "all" ? (statusFilter as ListBackordersStatus) : undefined, limit: 100 });
  const releaseMut = useReleaseBackorder();
  const cancelMut = useCancelBackorder();
  const backorders = (list as { data?: unknown[] } | null)?.data ?? (Array.isArray(list) ? (list as unknown[]) : []);
  const invalidate = () => qc.invalidateQueries({ queryKey: ["listBackorders"] });

  async function handleRelease(id: number) {
    try {
      await releaseMut.mutateAsync({ id, data: {} });
      toast({ title: "Backorder released" });
      invalidate();
    } catch { toast({ title: "Failed to release", variant: "destructive" }); }
  }

  async function handleCancel(id: number) {
    try {
      await cancelMut.mutateAsync({ id });
      toast({ title: "Backorder cancelled" });
      invalidate();
    } catch { toast({ title: "Failed to cancel", variant: "destructive" }); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h3 className="text-lg font-semibold">Backorders</h3>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="released">Released</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={invalidate}>
          <RefreshCw className="w-3 h-3 mr-1" /> Refresh
        </Button>
      </div>
      {isLoading ? (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      ) : (backorders as BackorderRow[]).length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">No backorders found.</div>
      ) : (
        <div className="border rounded-md overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Ordered Qty</TableHead>
                <TableHead className="text-right">Backorder Qty</TableHead>
                <TableHead className="text-right">Released Qty</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(backorders as BackorderRow[]).map((bo) => (
                <TableRow key={bo.id}>
                  <TableCell className="font-mono text-sm">{bo.code}</TableCell>
                  <TableCell>{bo.customerName ?? "—"}</TableCell>
                  <TableCell>{bo.itemCode ? `${bo.itemCode} ${bo.itemName ?? ""}` : bo.itemName ?? "—"}</TableCell>
                  <TableCell className="text-right">{fmt(bo.orderedQty, 0)}</TableCell>
                  <TableCell className="text-right font-semibold text-orange-600">{fmt(bo.backorderQty, 0)}</TableCell>
                  <TableCell className="text-right">{fmt(bo.releasedQty, 0)}</TableCell>
                  <TableCell><StatusBadge status={bo.status} /></TableCell>
                  <TableCell>
                    {bo.status === "open" && (
                      <div className="flex gap-1">
                        <Button size="sm" variant="outline" onClick={() => handleRelease(bo.id ?? 0)}>
                          <CheckCircle2 className="w-3 h-3 mr-1" /> Release
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => handleCancel(bo.id ?? 0)}>
                          <XCircle className="w-3 h-3 mr-1" /> Cancel
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

type BackorderRow = {
  id?: number;
  code?: string;
  customerName?: string;
  itemCode?: string;
  itemName?: string;
  orderedQty?: string | number;
  backorderQty?: string | number;
  releasedQty?: string | number;
  status?: string;
};

// ═══════════════════════════════════════════════════════════════════════════════
// ── Main Sales Page ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export default function Sales() {
  const [tab, setTab] = useState("dashboard");
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Sales</h2>
        <p className="text-muted-foreground">
          Manage quotations, orders, despatches, invoices, and returns.
        </p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="dashboard" className="gap-1.5">
            <TrendingUp className="w-4 h-4" /> Dashboard
          </TabsTrigger>
          <TabsTrigger value="quotations" className="gap-1.5">
            <FileText className="w-4 h-4" /> Quotations
          </TabsTrigger>
          <TabsTrigger value="orders" className="gap-1.5">
            <ClipboardList className="w-4 h-4" /> Orders
          </TabsTrigger>
          <TabsTrigger value="pick-slips" className="gap-1.5">
            <Package className="w-4 h-4" /> Pick Slips
          </TabsTrigger>
          <TabsTrigger value="despatches" className="gap-1.5">
            <Truck className="w-4 h-4" /> Despatches
          </TabsTrigger>
          <TabsTrigger value="invoices" className="gap-1.5">
            <ReceiptText className="w-4 h-4" /> Invoices
          </TabsTrigger>
          <TabsTrigger value="credit-notes" className="gap-1.5">
            <BadgeDollarSign className="w-4 h-4" /> Credit Notes
          </TabsTrigger>
          <TabsTrigger value="rma" className="gap-1.5">
            <RotateCcw className="w-4 h-4" /> RMA
          </TabsTrigger>
          <TabsTrigger value="backorders" className="gap-1.5">
            <AlertCircle className="w-4 h-4" /> Backorders
          </TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-4">
          <DashboardTab onNavigate={setTab} />
        </TabsContent>
        <TabsContent value="quotations" className="mt-4">
          <QuotationsTab />
        </TabsContent>
        <TabsContent value="orders" className="mt-4">
          <SalesOrdersTab />
        </TabsContent>
        <TabsContent value="pick-slips" className="mt-4">
          <PickSlipsTab />
        </TabsContent>
        <TabsContent value="despatches" className="mt-4">
          <DespatchesTab />
        </TabsContent>
        <TabsContent value="invoices" className="mt-4">
          <InvoicesTab />
        </TabsContent>
        <TabsContent value="credit-notes" className="mt-4">
          <CreditNotesTab />
        </TabsContent>
        <TabsContent value="rma" className="mt-4">
          <RmaTab />
        </TabsContent>
        <TabsContent value="backorders" className="mt-4">
          <BackordersTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
