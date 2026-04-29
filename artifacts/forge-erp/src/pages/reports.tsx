import { useState } from "react";
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

function fmt(n: any, isCurrency = false) {
  if (n == null) return "—";
  const num = Number(n);
  if (isCurrency) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
  }
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num);
}

function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString();
}

function StockValuationTab() {
  const [warehouseId, setWarehouseId] = useState("all");
  const { data: warehouses } = useListWarehouses({ limit: 100 });
  
  const { data, isLoading } = useGetInventoryReportsStockValuation({
    warehouseId: warehouseId !== "all" ? Number(warehouseId) : undefined
  });

  const rows = data?.rows || [];

  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <Select value={warehouseId} onValueChange={setWarehouseId}>
          <SelectTrigger className="w-[250px]"><SelectValue placeholder="All Warehouses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Warehouses</SelectItem>
            {(warehouses?.warehouses || []).map((w: any) => (
              <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline"><Download className="h-4 w-4 mr-2" />Export CSV</Button>
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
                {rows.map((r: any, i: number) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono">{r.itemCode}</TableCell>
                    <TableCell className="font-medium">{r.itemName}</TableCell>
                    <TableCell>{r.warehouseName || "—"}</TableCell>
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

  const rows = data?.data || [];

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
              rows.map((r: any, i: number) => (
                <TableRow key={i}>
                  <TableCell>{fmtDate(r.createdAt)}</TableCell>
                  <TableCell className="capitalize">{r.movementType}</TableCell>
                  <TableCell>
                    <div className="font-mono">{r.itemCode}</div>
                    <div className="text-sm text-muted-foreground">{r.itemName}</div>
                  </TableCell>
                  <TableCell>{r.warehouseName || "—"}</TableCell>
                  <TableCell className={`text-right font-mono font-medium ${Number(r.quantity) < 0 ? 'text-destructive' : 'text-emerald-600'}`}>
                    {Number(r.quantity) > 0 ? '+' : ''}{fmt(r.quantity)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.refCode || "—"}</TableCell>
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
  const { data: warehouses } = useListWarehouses({ limit: 100 });
  
  const { data, isLoading } = useGetInventoryReportsSlowMoving({
    days: days[0],
    warehouseId: warehouseId !== "all" ? Number(warehouseId) : undefined
  });

  const rows = data?.rows || [];

  return (
    <div className="space-y-4">
      <div className="flex gap-6 items-center">
        <Select value={warehouseId} onValueChange={setWarehouseId}>
          <SelectTrigger className="w-[250px]"><SelectValue placeholder="All Warehouses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Warehouses</SelectItem>
            {(warehouses?.warehouses || []).map((w: any) => (
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
              rows.map((r: any, i: number) => (
                <TableRow key={i}>
                  <TableCell>
                    <div className="font-mono font-medium">{r.itemCode}</div>
                    <div className="text-sm text-muted-foreground">{r.itemName}</div>
                  </TableCell>
                  <TableCell>{r.warehouseName || "—"}</TableCell>
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

  const rows = data?.rows || [];

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
                  {rows.map((r: any, i: number) => (
                    <TableRow key={i}>
                      <TableCell>
                        <div className="font-mono font-medium">{r.itemCode}</div>
                        <div className="text-sm text-muted-foreground">{r.itemName}</div>
                      </TableCell>
                      <TableCell className="text-right font-mono">{fmt(r.qtyExpected)}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(r.qtyActual)}</TableCell>
                      <TableCell className={`text-right font-mono font-medium ${r.variance < 0 ? 'text-destructive' : 'text-emerald-600'}`}>
                        {r.variance > 0 ? '+' : ''}{fmt(r.variance)}
                      </TableCell>
                      <TableCell className={`text-right font-mono font-medium ${r.varianceValue < 0 ? 'text-destructive' : 'text-emerald-600'}`}>
                        {r.varianceValue > 0 ? '+' : ''}{fmt(r.varianceValue, true)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="bg-muted/50 font-bold">
                    <TableCell colSpan={4} className="text-right">Total Net Variance</TableCell>
                    <TableCell className={`text-right font-mono text-lg ${Number(data?.totalVarianceValue) < 0 ? 'text-destructive' : 'text-emerald-600'}`}>
                      {Number(data?.totalVarianceValue) > 0 ? '+' : ''}{fmt(data?.totalVarianceValue, true)}
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

interface PoSummaryRow { status: string; count: number; total: number; }
interface SupplierRow { supplierId: number | null; supplierName: string | null; totalOrders: number; totalValue: number; avgOrderValue: number; }
interface SalesPeriodRow { period: string; totalRevenue: string; invoiceCount: number; orderCount: number; }
interface SalesItemRow { itemId: number | null; itemCode: string | null; itemName: string | null; totalQty: string; totalRevenue: string; invoiceCount: number; }

function ProcurementPoSummaryTab() {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const { data, isLoading } = useReportPoSummary(
    { from: fromDate || undefined, to: toDate || undefined }
  );
  const rows: PoSummaryRow[] = (data as PoSummaryRow[] | undefined) ?? [];
  const grandTotal = rows.reduce((s, r) => s + Number(r.total ?? 0), 0);
  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center">
        <Label className="whitespace-nowrap">From</Label>
        <Input type="date" className="w-40" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        <Label className="whitespace-nowrap">To</Label>
        <Input type="date" className="w-40" value={toDate} onChange={(e) => setToDate(e.target.value)} />
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
  const rows: SupplierRow[] = (data as SupplierRow[] | undefined) ?? [];
  return (
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
  );
}

function SalesByPeriodTab() {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const { data, isLoading } = useReportSalesByPeriod(
    { fromDate: fromDate || undefined, toDate: toDate || undefined }
  );
  const rows: SalesPeriodRow[] = (data as SalesPeriodRow[] | undefined) ?? [];
  const grandRevenue = rows.reduce((s, r) => s + Number(r.totalRevenue ?? 0), 0);
  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center">
        <Label className="whitespace-nowrap">From</Label>
        <Input type="date" className="w-40" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        <Label className="whitespace-nowrap">To</Label>
        <Input type="date" className="w-40" value={toDate} onChange={(e) => setToDate(e.target.value)} />
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
                    <TableCell className="text-right font-mono font-medium">{fmt(Number(r.totalRevenue), true)}</TableCell>
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
  const rows: SalesItemRow[] = (data as SalesItemRow[] | undefined) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center">
        <Label className="whitespace-nowrap">From</Label>
        <Input type="date" className="w-40" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        <Label className="whitespace-nowrap">To</Label>
        <Input type="date" className="w-40" value={toDate} onChange={(e) => setToDate(e.target.value)} />
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
                <TableCell className="text-right font-mono">{fmt(Number(r.totalQty))}</TableCell>
                <TableCell className="text-right font-mono">{r.invoiceCount}</TableCell>
                <TableCell className="text-right font-mono font-medium">{fmt(Number(r.totalRevenue), true)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

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
        
        <TabsContent value="inventory" className="space-y-6">
          <Tabs defaultValue="valuation" className="w-full">
            <div className="border-b mb-4 pb-2">
              <TabsList className="bg-transparent h-8 p-0">
                <TabsTrigger value="valuation" className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none bg-transparent">Stock Valuation</TabsTrigger>
                <TabsTrigger value="movement" className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none bg-transparent">Movement History</TabsTrigger>
                <TabsTrigger value="slow-moving" className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none bg-transparent">Slow Moving Items</TabsTrigger>
                <TabsTrigger value="variance" className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none bg-transparent">Stocktake Variance</TabsTrigger>
              </TabsList>
            </div>
            
            <TabsContent value="valuation"><StockValuationTab /></TabsContent>
            <TabsContent value="movement"><MovementHistoryTab /></TabsContent>
            <TabsContent value="slow-moving"><SlowMovingTab /></TabsContent>
            <TabsContent value="variance"><StocktakeVarianceTab /></TabsContent>
          </Tabs>
        </TabsContent>
        
        <TabsContent value="procurement">
          <Tabs defaultValue="po-summary" className="w-full">
            <div className="border-b mb-4 pb-2">
              <TabsList className="bg-transparent h-8 p-0">
                <TabsTrigger value="po-summary" className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none bg-transparent">PO Summary</TabsTrigger>
                <TabsTrigger value="supplier-performance" className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none bg-transparent">Supplier Spend</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="po-summary"><ProcurementPoSummaryTab /></TabsContent>
            <TabsContent value="supplier-performance"><SupplierSpendTab /></TabsContent>
          </Tabs>
        </TabsContent>

        <TabsContent value="sales">
          <Tabs defaultValue="by-period" className="w-full">
            <div className="border-b mb-4 pb-2">
              <TabsList className="bg-transparent h-8 p-0">
                <TabsTrigger value="by-period" className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none bg-transparent">Revenue by Period</TabsTrigger>
                <TabsTrigger value="by-item" className="data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:shadow-none rounded-none bg-transparent">Top Products</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="by-period"><SalesByPeriodTab /></TabsContent>
            <TabsContent value="by-item"><SalesByItemTab /></TabsContent>
          </Tabs>
        </TabsContent>
      </Tabs>
    </div>
  );
}