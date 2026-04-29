import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { 
  useGetInventoryReportsStockValuation,
  useGetInventoryReportsMovementHistory,
  useGetInventoryReportsSlowMoving,
  useGetInventoryReportsStocktakeVariance,
  getGetInventoryReportsStocktakeVarianceQueryKey,
  useListWarehouses,
  useReportPoSummary,
  useReportSupplierPerformance,
  useReportSalesByPeriod,
  useReportSalesByItem,
  useReportBackorders,
  useReportGoodsInTransit,
} from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Download } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

// ── Formatters ─────────────────────────────────────────────────────────────────

function fmt(n: number | string | null | undefined, isCurrency = false): string {
  if (n == null) return "—";
  const num = Number(n);
  if (isCurrency) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(num);
  }
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num);
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString();
}

function exportCsv(url: string) {
  window.open(url, "_blank");
}

// ── Row DTOs ──────────────────────────────────────────────────────────────────

interface StockValuationRow { itemCode: string; itemName: string; warehouseName: string | null; qtyOnHand: number | string; averageCost: number | string; totalValue: number | string; }
interface MovementHistoryRow { createdAt: string; movementType: string; itemCode: string; itemName: string; warehouseName: string | null; quantity: number | string; refCode: string | null; }
interface SlowMovingRow { itemCode: string; itemName: string; warehouseName: string | null; qtyOnHand: number | string; totalValue: number | string; lastMovementAt: string; daysSinceMovement: number; }
interface StocktakeVarianceRow { itemCode: string; itemName: string; qtyExpected: number | string; qtyActual: number | string; variance: number | string; varianceValue: number | string; }
interface WarehouseItem { id: number; name: string; }

interface PoSummaryRow { status: string; count: number; total: number | string; }
interface SupplierRow { supplierId: number | null; supplierName: string | null; totalOrders: number; totalValue: number | string; avgOrderValue: number | string; }
interface GrnRow { id: number; grnCode: string; poCode: string; supplierName: string; receivedAt: string | null; receivedByEmail: string | null; totalReceivedQty: number | string; totalValue: number | string; lineCount: number | string; }
interface GoodsInTransitRow { id: number; code: string; supplierName: string | null; status: string; total: number | string; deliveryDate: string | null; outstandingQty: number; }

interface SalesPeriodRow { period: string; totalRevenue: string | number; invoiceCount: number; orderCount: number; }
interface SalesItemRow { itemId: number | null; itemCode: string | null; itemName: string | null; totalQty: string | number; totalRevenue: string | number; invoiceCount: number; }
interface BackorderRow { soId: number; soLineId: number; itemCode: string | null; itemName: string | null; qty: string | number; despatched: string | number; backorderQty: string | number; }
interface InvoiceAgingInvoice { id: number; code: string; customerName: string | null; invoiceDate: string | null; dueDate: string | null; total: number; paidAmount: number; balance: number; daysOverdue: number | null; agingBucket: string; }
interface AgingBucketSummary { count: number; total: number; }
interface InvoiceAgingResponse { invoices: InvoiceAgingInvoice[]; summary: Record<string, AgingBucketSummary>; }

// ── Inventory Tabs ────────────────────────────────────────────────────────────

function StockValuationTab() {
  const [warehouseId, setWarehouseId] = useState("all");
  const { data: warehouseData } = useListWarehouses({ limit: 100 });
  const warehouses = (warehouseData?.warehouses as unknown as WarehouseItem[] | undefined) ?? [];

  const { data, isLoading } = useGetInventoryReportsStockValuation({
    warehouseId: warehouseId !== "all" ? Number(warehouseId) : undefined
  });

  const rows = (data?.rows as unknown as StockValuationRow[] | undefined) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <Select value={warehouseId} onValueChange={setWarehouseId}>
          <SelectTrigger className="w-[250px]"><SelectValue placeholder="All Warehouses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Warehouses</SelectItem>
            {warehouses.map((w) => (
              <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => exportCsv(`/api/inventory/reports/stock-valuation/export/csv${warehouseId !== "all" ? `?warehouseId=${warehouseId}` : ""}`)}>
          <Download className="h-4 w-4 mr-2" />Export CSV
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item Code</TableHead>
              <TableHead>Item Name</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead className="text-right">Qty On Hand</TableHead>
              <TableHead className="text-right">Avg Cost</TableHead>
              <TableHead className="text-right">Total Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8">Loading report...</TableCell></TableRow>
            ) : !rows.length ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8">No stock found</TableCell></TableRow>
            ) : (
              <>
                {rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono">{r.itemCode}</TableCell>
                    <TableCell className="font-medium">{r.itemName}</TableCell>
                    <TableCell>{r.warehouseName ?? "—"}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(r.qtyOnHand)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(r.averageCost, true)}</TableCell>
                    <TableCell className="text-right font-mono font-medium">{fmt(r.totalValue, true)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/50 font-bold">
                  <TableCell colSpan={5} className="text-right">Grand Total</TableCell>
                  <TableCell className="text-right font-mono text-lg text-primary">{fmt(data?.grandTotal, true)}</TableCell>
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function MovementHistoryTab() {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [movementType, setMovementType] = useState("all");

  const { data, isLoading } = useGetInventoryReportsMovementHistory({
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    movementType: movementType !== "all" ? movementType : undefined,
    limit: 100
  });

  const rows = (data?.data as unknown as MovementHistoryRow[] | undefined) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input type="date" className="w-40" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        <Input type="date" className="w-40" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        <Select value={movementType} onValueChange={setMovementType}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="All Types" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Movement Types</SelectItem>
            <SelectItem value="receipt">Receipt</SelectItem>
            <SelectItem value="despatch">Despatch</SelectItem>
            <SelectItem value="adjustment">Adjustment</SelectItem>
            <SelectItem value="transfer">Transfer</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Item</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead>Ref</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8">Loading history...</TableCell></TableRow>
            ) : !rows.length ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8">No movements found</TableCell></TableRow>
            ) : (
              rows.map((r, i) => (
                <TableRow key={i}>
                  <TableCell>{fmtDate(r.createdAt)}</TableCell>
                  <TableCell className="capitalize">{r.movementType}</TableCell>
                  <TableCell>
                    <div className="font-mono">{r.itemCode}</div>
                    <div className="text-sm text-muted-foreground">{r.itemName}</div>
                  </TableCell>
                  <TableCell>{r.warehouseName ?? "—"}</TableCell>
                  <TableCell className={`text-right font-mono font-medium ${Number(r.quantity) < 0 ? "text-destructive" : "text-emerald-600"}`}>
                    {Number(r.quantity) > 0 ? "+" : ""}{fmt(r.quantity)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.refCode ?? "—"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SlowMovingTab() {
  const [days, setDays] = useState([90]);
  const [warehouseId, setWarehouseId] = useState("all");
  const { data: warehouseData } = useListWarehouses({ limit: 100 });
  const warehouses = (warehouseData?.warehouses as unknown as WarehouseItem[] | undefined) ?? [];

  const { data, isLoading } = useGetInventoryReportsSlowMoving({
    days: days[0],
    warehouseId: warehouseId !== "all" ? Number(warehouseId) : undefined
  });

  const rows = (data?.rows as unknown as SlowMovingRow[] | undefined) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex gap-6 items-center">
        <Select value={warehouseId} onValueChange={setWarehouseId}>
          <SelectTrigger className="w-[250px]"><SelectValue placeholder="All Warehouses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Warehouses</SelectItem>
            {warehouses.map((w) => (
              <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex-1 max-w-md space-y-2">
          <div className="flex justify-between">
            <Label>Inactivity Period</Label>
            <span className="text-sm font-medium">{days[0]} Days</span>
          </div>
          <Slider min={30} max={365} step={15} value={days} onValueChange={setDays} />
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead>Warehouse</TableHead>
              <TableHead className="text-right">Qty On Hand</TableHead>
              <TableHead className="text-right">Total Value</TableHead>
              <TableHead>Last Movement</TableHead>
              <TableHead className="text-right">Days Inactive</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8">Loading report...</TableCell></TableRow>
            ) : !rows.length ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8">No slow moving stock found</TableCell></TableRow>
            ) : (
              rows.map((r, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <div className="font-mono font-medium">{r.itemCode}</div>
                    <div className="text-sm text-muted-foreground">{r.itemName}</div>
                  </TableCell>
                  <TableCell>{r.warehouseName ?? "—"}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(r.qtyOnHand)}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(r.totalValue, true)}</TableCell>
                  <TableCell>{fmtDate(r.lastMovementAt)}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant={r.daysSinceMovement > 180 ? "destructive" : "secondary"}>
                      {r.daysSinceMovement} days
                    </Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function StocktakeVarianceTab() {
  const [stocktakeRunId, setStocktakeRunId] = useState("");

  const svParams = { stocktakeRunId: stocktakeRunId ? Number(stocktakeRunId) : undefined };
  const { data, isLoading } = useGetInventoryReportsStocktakeVariance(svParams, { query: { enabled: !!stocktakeRunId, queryKey: getGetInventoryReportsStocktakeVarianceQueryKey(svParams) }});

  const rows = (data?.rows as unknown as StocktakeVarianceRow[] | undefined) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex gap-4 items-center">
        <Input
          placeholder="Stocktake Run ID..."
          value={stocktakeRunId}
          onChange={(e) => setStocktakeRunId(e.target.value)}
          className="w-[200px]"
        />
        <p className="text-sm text-muted-foreground">Enter a completed run ID to view variance report</p>
      </div>

      {!stocktakeRunId ? (
        <div className="py-12 border rounded-md border-dashed text-center text-muted-foreground">
          Enter a stocktake run ID above
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Expected Qty</TableHead>
                <TableHead className="text-right">Actual Qty</TableHead>
                <TableHead className="text-right">Variance Qty</TableHead>
                <TableHead className="text-right">Variance Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8">Loading report...</TableCell></TableRow>
              ) : !rows.length ? (
                <TableRow><TableCell colSpan={5} className="text-center py-8">No variances found for this run</TableCell></TableRow>
              ) : (
                <>
                  {rows.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <div className="font-mono font-medium">{r.itemCode}</div>
                        <div className="text-sm text-muted-foreground">{r.itemName}</div>
                      </TableCell>
                      <TableCell className="text-right font-mono">{fmt(r.qtyExpected)}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(r.qtyActual)}</TableCell>
                      <TableCell className={`text-right font-mono font-medium ${Number(r.variance) < 0 ? "text-destructive" : "text-emerald-600"}`}>
                        {Number(r.variance) > 0 ? "+" : ""}{fmt(r.variance)}
                      </TableCell>
                      <TableCell className={`text-right font-mono font-medium ${Number(r.varianceValue) < 0 ? "text-destructive" : "text-emerald-600"}`}>
                        {Number(r.varianceValue) > 0 ? "+" : ""}{fmt(r.varianceValue, true)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-muted/50 font-bold">
                    <TableCell colSpan={4} className="text-right">Total Net Variance</TableCell>
                    <TableCell className={`text-right font-mono text-lg ${Number(data?.totalVarianceValue) < 0 ? "text-destructive" : "text-emerald-600"}`}>
                      {Number(data?.totalVarianceValue) > 0 ? "+" : ""}{fmt(data?.totalVarianceValue, true)}
                    </TableCell>
                  </TableRow>
                </>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ── Procurement Tabs ───────────────────────────────────────────────────────────

function ProcurementPoSummaryTab() {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const { data, isLoading } = useReportPoSummary(
    { from: fromDate || undefined, to: toDate || undefined }
  );
  const rows = (data as unknown as PoSummaryRow[] | undefined) ?? [];
  const grandTotal = rows.reduce((s, r) => s + Number(r.total ?? 0), 0);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-2 items-center">
          <Label className="whitespace-nowrap">From</Label>
          <Input type="date" className="w-40" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <Label className="whitespace-nowrap">To</Label>
          <Input type="date" className="w-40" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        <Button variant="outline" onClick={() => exportCsv(`/api/procurement/reports/po-summary/export/csv${fromDate || toDate ? `?${new URLSearchParams({ from: fromDate, to: toDate })}` : ""}`)}>
          <Download className="h-4 w-4 mr-2" />Export CSV
        </Button>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead className="text-right">Total Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={3} className="text-center py-8">Loading report...</TableCell></TableRow>
            ) : !rows.length ? (
              <TableRow><TableCell colSpan={3} className="text-center py-8">No purchase orders found</TableCell></TableRow>
            ) : (
              <>
                {rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell><Badge variant="outline" className="capitalize">{r.status.replace(/_/g, " ")}</Badge></TableCell>
                    <TableCell className="text-right font-mono">{r.count}</TableCell>
                    <TableCell className="text-right font-mono font-medium">{fmt(r.total, true)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/50 font-bold">
                  <TableCell colSpan={2} className="text-right">Grand Total</TableCell>
                  <TableCell className="text-right font-mono text-lg text-primary">{fmt(grandTotal, true)}</TableCell>
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SupplierSpendTab() {
  const { data, isLoading } = useReportSupplierPerformance();
  const rows = (data as unknown as SupplierRow[] | undefined) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="outline" onClick={() => exportCsv("/api/procurement/reports/supplier-performance/export/csv")}>
          <Download className="h-4 w-4 mr-2" />Export CSV
        </Button>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Supplier</TableHead>
              <TableHead className="text-right">Total Orders</TableHead>
              <TableHead className="text-right">Total Spend</TableHead>
              <TableHead className="text-right">Avg Order Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8">Loading report...</TableCell></TableRow>
            ) : !rows.length ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8">No supplier data found</TableCell></TableRow>
            ) : rows.map((r, i) => (
              <TableRow key={i}>
                <TableCell className="font-medium">{r.supplierName ?? "—"}</TableCell>
                <TableCell className="text-right font-mono">{r.totalOrders}</TableCell>
                <TableCell className="text-right font-mono font-medium">{fmt(r.totalValue, true)}</TableCell>
                <TableCell className="text-right font-mono">{fmt(r.avgOrderValue, true)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function GrnTab() {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const params = new URLSearchParams();
  if (fromDate) params.set("from", fromDate);
  if (toDate) params.set("to", toDate);
  const queryString = params.toString();

  const { data: rows = [], isLoading } = useQuery<GrnRow[]>({
    queryKey: ["grn-report", fromDate, toDate],
    queryFn: async () => {
      const res = await fetch(`/api/procurement/reports/grn${queryString ? `?${queryString}` : ""}`);
      if (!res.ok) throw new Error("Failed to load GRN report");
      return res.json() as Promise<GrnRow[]>;
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-2 items-center">
          <Label className="whitespace-nowrap">From</Label>
          <Input type="date" className="w-40" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <Label className="whitespace-nowrap">To</Label>
          <Input type="date" className="w-40" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        <Button variant="outline" onClick={() => exportCsv(`/api/procurement/reports/grn/export/csv${queryString ? `?${queryString}` : ""}`)}>
          <Download className="h-4 w-4 mr-2" />Export CSV
        </Button>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>GRN Code</TableHead>
              <TableHead>PO Code</TableHead>
              <TableHead>Supplier</TableHead>
              <TableHead>Received At</TableHead>
              <TableHead>Received By</TableHead>
              <TableHead className="text-right">Items</TableHead>
              <TableHead className="text-right">Total Qty</TableHead>
              <TableHead className="text-right">Total Value</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8">Loading GRN report...</TableCell></TableRow>
            ) : !rows.length ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8">No goods received notes found</TableCell></TableRow>
            ) : rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono font-medium">{r.grnCode}</TableCell>
                <TableCell className="font-mono text-muted-foreground">{r.poCode}</TableCell>
                <TableCell>{r.supplierName}</TableCell>
                <TableCell>{fmtDate(r.receivedAt)}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.receivedByEmail ?? "—"}</TableCell>
                <TableCell className="text-right font-mono">{Number(r.lineCount)}</TableCell>
                <TableCell className="text-right font-mono">{fmt(r.totalReceivedQty)}</TableCell>
                <TableCell className="text-right font-mono font-medium">{fmt(r.totalValue, true)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function GoodsInTransitTab() {
  const { data, isLoading } = useReportGoodsInTransit({});
  const rows = (data as unknown as GoodsInTransitRow[] | undefined) ?? [];
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>PO Code</TableHead>
            <TableHead>Supplier</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Expected By</TableHead>
            <TableHead className="text-right">Outstanding Qty</TableHead>
            <TableHead className="text-right">PO Value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            <TableRow><TableCell colSpan={6} className="text-center py-8">Loading...</TableCell></TableRow>
          ) : !rows.length ? (
            <TableRow><TableCell colSpan={6} className="text-center py-8">No items in transit</TableCell></TableRow>
          ) : rows.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-mono font-medium">{r.code}</TableCell>
              <TableCell>{r.supplierName ?? "—"}</TableCell>
              <TableCell><Badge variant="outline" className="capitalize">{r.status.replace(/_/g, " ")}</Badge></TableCell>
              <TableCell>{fmtDate(r.deliveryDate)}</TableCell>
              <TableCell className="text-right font-mono">{fmt(r.outstandingQty)}</TableCell>
              <TableCell className="text-right font-mono font-medium">{fmt(r.total, true)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Sales Tabs ────────────────────────────────────────────────────────────────

function SalesByPeriodTab() {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const { data, isLoading } = useReportSalesByPeriod(
    { fromDate: fromDate || undefined, toDate: toDate || undefined }
  );
  const rows = (data as unknown as SalesPeriodRow[] | undefined) ?? [];
  const grandRevenue = rows.reduce((s, r) => s + Number(r.totalRevenue ?? 0), 0);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-2 items-center">
          <Label className="whitespace-nowrap">From</Label>
          <Input type="date" className="w-40" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <Label className="whitespace-nowrap">To</Label>
          <Input type="date" className="w-40" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        <Button variant="outline" onClick={() => exportCsv(`/api/sales/reports/by-period/export/csv${fromDate || toDate ? `?${new URLSearchParams({ fromDate, toDate })}` : ""}`)}>
          <Download className="h-4 w-4 mr-2" />Export CSV
        </Button>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Invoices</TableHead>
              <TableHead className="text-right">Orders</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8">Loading report...</TableCell></TableRow>
            ) : !rows.length ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8">No sales data found</TableCell></TableRow>
            ) : (
              <>
                {rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono font-medium">{r.period}</TableCell>
                    <TableCell className="text-right font-mono">{r.invoiceCount}</TableCell>
                    <TableCell className="text-right font-mono">{r.orderCount}</TableCell>
                    <TableCell className="text-right font-mono font-medium">{fmt(r.totalRevenue, true)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/50 font-bold">
                  <TableCell colSpan={3} className="text-right">Total Revenue</TableCell>
                  <TableCell className="text-right font-mono text-lg text-primary">{fmt(grandRevenue, true)}</TableCell>
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SalesByItemTab() {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const { data, isLoading } = useReportSalesByItem(
    { fromDate: fromDate || undefined, toDate: toDate || undefined }
  );
  const rows = (data as unknown as SalesItemRow[] | undefined) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-2 items-center">
          <Label className="whitespace-nowrap">From</Label>
          <Input type="date" className="w-40" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <Label className="whitespace-nowrap">To</Label>
          <Input type="date" className="w-40" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        <Button variant="outline" onClick={() => exportCsv(`/api/sales/reports/by-item/export/csv${fromDate || toDate ? `?${new URLSearchParams({ fromDate, toDate })}` : ""}`)}>
          <Download className="h-4 w-4 mr-2" />Export CSV
        </Button>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Qty Sold</TableHead>
              <TableHead className="text-right">Invoices</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8">Loading report...</TableCell></TableRow>
            ) : !rows.length ? (
              <TableRow><TableCell colSpan={4} className="text-center py-8">No sales data found</TableCell></TableRow>
            ) : rows.map((r, i) => (
              <TableRow key={i}>
                <TableCell>
                  <div className="font-mono font-medium">{r.itemCode ?? "—"}</div>
                  <div className="text-sm text-muted-foreground">{r.itemName ?? "—"}</div>
                </TableCell>
                <TableCell className="text-right font-mono">{fmt(r.totalQty)}</TableCell>
                <TableCell className="text-right font-mono">{r.invoiceCount}</TableCell>
                <TableCell className="text-right font-mono font-medium">{fmt(r.totalRevenue, true)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function BackordersTab() {
  const { data, isLoading } = useReportBackorders();
  const rows = (data as unknown as BackorderRow[] | undefined) ?? [];
  const totalBackorder = rows.reduce((s, r) => s + Number(r.backorderQty ?? 0), 0);
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="outline" onClick={() => exportCsv("/api/sales/reports/backorders/export/csv")}>
          <Download className="h-4 w-4 mr-2" />Export CSV
        </Button>
      </div>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>SO ID</TableHead>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Ordered</TableHead>
              <TableHead className="text-right">Despatched</TableHead>
              <TableHead className="text-right">Backorder Qty</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8">Loading backorders...</TableCell></TableRow>
            ) : !rows.length ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8">No open backorders — great!</TableCell></TableRow>
            ) : (
              <>
                {rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-muted-foreground">SO-{r.soId}</TableCell>
                    <TableCell>
                      <div className="font-mono font-medium">{r.itemCode ?? "—"}</div>
                      <div className="text-sm text-muted-foreground">{r.itemName ?? "—"}</div>
                    </TableCell>
                    <TableCell className="text-right font-mono">{fmt(r.qty)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(r.despatched)}</TableCell>
                    <TableCell className="text-right font-mono font-bold text-orange-600">{fmt(r.backorderQty)}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/50 font-bold">
                  <TableCell colSpan={4} className="text-right">Total Backorder Qty</TableCell>
                  <TableCell className="text-right font-mono text-orange-600">{fmt(totalBackorder)}</TableCell>
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

const AGING_BUCKETS: { key: string; label: string; color: string }[] = [
  { key: "current",  label: "Current",    color: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  { key: "1_to_30",  label: "1–30 Days",  color: "bg-yellow-100 text-yellow-800 border-yellow-200" },
  { key: "31_to_60", label: "31–60 Days", color: "bg-orange-100 text-orange-800 border-orange-200" },
  { key: "61_to_90", label: "61–90 Days", color: "bg-red-100 text-red-800 border-red-200" },
  { key: "over_90",  label: "90+ Days",   color: "bg-red-200 text-red-900 border-red-300" },
];

function InvoiceAgingTab() {
  const { data, isLoading } = useQuery<InvoiceAgingResponse>({
    queryKey: ["invoice-aging"],
    queryFn: async () => {
      const res = await fetch("/api/sales/reports/invoice-aging");
      if (!res.ok) throw new Error("Failed to load aging report");
      return res.json() as Promise<InvoiceAgingResponse>;
    },
  });

  const invoices = data?.invoices ?? [];
  const summary = data?.summary ?? {};

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="outline" onClick={() => exportCsv("/api/sales/reports/invoice-aging/export/csv")}>
          <Download className="h-4 w-4 mr-2" />Export CSV
        </Button>
      </div>

      <div className="grid grid-cols-5 gap-3">
        {AGING_BUCKETS.map(({ key, label, color }) => {
          const bucket = summary[key] ?? { count: 0, total: 0 };
          return (
            <Card key={key} className={`border ${color}`}>
              <CardContent className="p-4">
                <p className="text-xs font-semibold uppercase tracking-wide mb-1">{label}</p>
                <p className="text-xl font-bold">{fmt(bucket.total, true)}</p>
                <p className="text-xs mt-1">{bucket.count} invoice{bucket.count !== 1 ? "s" : ""}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Invoice</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Invoice Date</TableHead>
              <TableHead>Due Date</TableHead>
              <TableHead className="text-right">Total</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead className="text-right">Balance</TableHead>
              <TableHead>Bucket</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8">Loading aging report...</TableCell></TableRow>
            ) : !invoices.length ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8">No outstanding invoices</TableCell></TableRow>
            ) : invoices.map((r) => {
              const bucket = AGING_BUCKETS.find(b => b.key === r.agingBucket);
              return (
                <TableRow key={r.id}>
                  <TableCell className="font-mono font-medium">{r.code}</TableCell>
                  <TableCell>{r.customerName ?? "—"}</TableCell>
                  <TableCell>{fmtDate(r.invoiceDate)}</TableCell>
                  <TableCell>{fmtDate(r.dueDate)}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(r.total, true)}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(r.paidAmount, true)}</TableCell>
                  <TableCell className="text-right font-mono font-bold">{fmt(r.balance, true)}</TableCell>
                  <TableCell>
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold border ${bucket?.color ?? ""}`}>
                      {bucket?.label ?? r.agingBucket}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ── Reports Page ───────────────────────────────────────────────────────────────

export default function Reports() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Reports</h2>
        <p className="text-muted-foreground">Operational reports, analytics, and business intelligence.</p>
      </div>

      <Tabs defaultValue="inventory" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          <TabsTrigger value="procurement">Procurement</TabsTrigger>
          <TabsTrigger value="sales">Sales</TabsTrigger>
        </TabsList>

        <TabsContent value="inventory">
          <Tabs defaultValue="stock-valuation">
            <TabsList className="mb-4">
              <TabsTrigger value="stock-valuation">Stock Valuation</TabsTrigger>
              <TabsTrigger value="movements">Movement History</TabsTrigger>
              <TabsTrigger value="slow-moving">Slow Moving</TabsTrigger>
              <TabsTrigger value="stocktake">Stocktake Variance</TabsTrigger>
            </TabsList>
            <TabsContent value="stock-valuation"><StockValuationTab /></TabsContent>
            <TabsContent value="movements"><MovementHistoryTab /></TabsContent>
            <TabsContent value="slow-moving"><SlowMovingTab /></TabsContent>
            <TabsContent value="stocktake"><StocktakeVarianceTab /></TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="procurement">
          <Tabs defaultValue="po-summary">
            <TabsList className="mb-4">
              <TabsTrigger value="po-summary">PO Summary</TabsTrigger>
              <TabsTrigger value="supplier-spend">Supplier Spend</TabsTrigger>
              <TabsTrigger value="grn">Goods Received</TabsTrigger>
              <TabsTrigger value="in-transit">Goods in Transit</TabsTrigger>
            </TabsList>
            <TabsContent value="po-summary"><ProcurementPoSummaryTab /></TabsContent>
            <TabsContent value="supplier-spend"><SupplierSpendTab /></TabsContent>
            <TabsContent value="grn"><GrnTab /></TabsContent>
            <TabsContent value="in-transit"><GoodsInTransitTab /></TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="sales">
          <Tabs defaultValue="by-period">
            <TabsList className="mb-4">
              <TabsTrigger value="by-period">Revenue by Period</TabsTrigger>
              <TabsTrigger value="by-item">Top Products</TabsTrigger>
              <TabsTrigger value="backorders">Backorders</TabsTrigger>
              <TabsTrigger value="invoice-aging">Invoice Aging</TabsTrigger>
            </TabsList>
            <TabsContent value="by-period"><SalesByPeriodTab /></TabsContent>
            <TabsContent value="by-item"><SalesByItemTab /></TabsContent>
            <TabsContent value="backorders"><BackordersTab /></TabsContent>
            <TabsContent value="invoice-aging"><InvoiceAgingTab /></TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>
    </div>
  );
}
