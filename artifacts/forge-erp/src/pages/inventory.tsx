import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm, useFieldArray } from "react-hook-form";
import {
  useListInventoryStockDashboard,
  useListInventoryMovements,
  useListInventoryAdjustments,
  useGetInventoryAdjustment,
  useCreateInventoryAdjustment,
  getListInventoryAdjustmentsQueryKey,
  getGetInventoryAdjustmentQueryKey,
  useCreateInventoryTransfer,
  useListInventoryTransfers,
  useReceiveInventoryTransfer,
  useCreateInventoryIssue,
  useCreateInventoryReturn,
  useListLotNumbers,
  useTraceLotNumber,
  useListStocktakeRuns,
  useCreateStocktakeRun,
  useGetStocktakeRun,
  useUpdateStocktakeLine,
  usePostStocktakeRun,
  getListStocktakeRunsQueryKey,
  getGetStocktakeRunQueryKey,
  useListCycleCounts,
  useCreateCycleCount,
  useGetCycleCount,
  useUpdateCycleCount,
  useUpdateCycleCountLine,
  getListCycleCountsQueryKey,
  getGetCycleCountQueryKey,
  useListWarehouses,
  useListItems,
  useListGlAccounts,
  useListSerialNumbers,
  useGetSerialNumber,
  useRegisterSerialNumber,
  useUpdateSerialNumber,
  useCreateDirectReceive,
  useCreateInventoryRepack,
  useCreateInventoryBuild,
  getTraceLotNumberQueryKey,
  getListInventoryTransfersQueryKey,
  getListSerialNumbersQueryKey,
  getGetSerialNumberQueryKey,
  getListInventoryMovementsQueryKey,
  type InventoryAdjustment,
  type InventoryAdjustmentLinesItem,
  type CreateInventoryTransfer201,
  type CreateStocktakeRun201,
  type PostStocktakeRun200,
  type StocktakeRun,
  type StocktakeLine,
  type CreateCycleCount201,
  type CycleCountTask,
  type CycleCountTaskLinesItem,
} from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  Package,
  ArrowLeftRight,
  ClipboardList,
  BarChart3,
  RefreshCw,
  Plus,
  Eye,
  Search,
  Boxes,
  SendToBack,
  Activity,
  Tag,
  Hash,
  Download,
  CheckCircle2,
  PackageCheck,
  Truck,
} from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: string | number | null | undefined, dec = 2) {
  if (n == null) return "—";
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function exportCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]) {
  const lines = [headers.join(","), ...rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function fmtDate(s: string | null | undefined) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString();
}

function MovementBadge({ type }: { type: string }) {
  const map: Record<string, string> = {
    receipt: "bg-green-100 text-green-800",
    despatch: "bg-blue-100 text-blue-800",
    adjustment: "bg-yellow-100 text-yellow-800",
    transfer: "bg-purple-100 text-purple-800",
    issue: "bg-orange-100 text-orange-800",
    return: "bg-teal-100 text-teal-800",
    repack: "bg-pink-100 text-pink-800",
    build: "bg-indigo-100 text-indigo-800",
  };
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium capitalize ${map[type] ?? "bg-gray-100 text-gray-700"}`}>
      {type}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    open: "default",
    counting: "secondary",
    variance: "outline",
    posted: "default",
    cancelled: "destructive",
    pending: "secondary",
    in_progress: "default",
    completed: "default",
    active: "default",
    expired: "destructive",
    quarantine: "outline",
    consumed: "secondary",
  };
  return <Badge variant={(map[status] as "default" | "secondary" | "outline" | "destructive") ?? "outline"}>{status.replace("_", " ")}</Badge>;
}

// ── Stock Dashboard Tab ───────────────────────────────────────────────────────

function StockDashboardTab() {
  const [search, setSearch] = useState("");
  const [warehouseFilter, setWarehouseFilter] = useState("all");
  const [categoryFilter, setCategoryFilter] = useState("");

  const { data: warehouses } = useListWarehouses({ limit: 100 });
  const { data: stock, isLoading } = useListInventoryStockDashboard({
    search: search || undefined,
    warehouseId: warehouseFilter !== "all" ? Number(warehouseFilter) : undefined,
    category: categoryFilter || undefined,
    limit: 100,
  });

  const rows = stock?.data ?? [];
  const totalValue = rows.reduce((s, r) => s + Number(r.stockValue ?? 0), 0);
  const totalItems = rows.length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">Stock Lines</p>
          <p className="text-2xl font-bold">{totalItems}</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">Total Stock Value</p>
          <p className="text-2xl font-bold">${fmt(totalValue)}</p>
        </div>
        <div className="rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">Warehouses</p>
          <p className="text-2xl font-bold">{warehouses?.warehouses?.length ?? 0}</p>
        </div>
      </div>

      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search items…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All Warehouses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Warehouses</SelectItem>
            {(warehouses?.warehouses ?? []).map((w) => (
              <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input placeholder="Category…" className="w-36" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} />
        <Button variant="outline" size="sm" onClick={() => exportCsv("stock.csv",
          ["Item Code","Item Name","Warehouse","Location","Lot","On Hand","Reserved","Available","Avg Cost","Value"],
          rows.map((r) => [r.itemCode, r.itemName, r.warehouseName, r.locationCode ?? r.locationName, r.lotNumber, r.qtyOnHand, r.qtyReserved, r.qtyAvailable, r.averageCost, r.stockValue])
        )}><Download className="h-4 w-4 mr-1" />Export CSV</Button>
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-muted-foreground">Loading stock…</div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Lot</TableHead>
                <TableHead className="text-right">On Hand</TableHead>
                <TableHead className="text-right">Reserved</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Avg Cost</TableHead>
                <TableHead className="text-right">Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No stock found</TableCell></TableRow>
              ) : rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div className="font-medium">{r.itemCode}</div>
                    <div className="text-xs text-muted-foreground">{r.itemName}</div>
                  </TableCell>
                  <TableCell>{r.warehouseName}</TableCell>
                  <TableCell>{r.locationCode ?? r.locationName ?? "—"}</TableCell>
                  <TableCell>{r.lotNumber ?? "—"}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(r.qtyOnHand, 4)}</TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">{fmt(r.qtyReserved, 4)}</TableCell>
                  <TableCell className="text-right font-mono font-semibold">{fmt(r.qtyAvailable, 4)}</TableCell>
                  <TableCell className="text-right font-mono">{r.averageCost ? `$${fmt(r.averageCost)}` : "—"}</TableCell>
                  <TableCell className="text-right font-mono">${fmt(r.stockValue)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ── Movement Log Tab ──────────────────────────────────────────────────────────

function MovementLogTab() {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const { data: movements, isLoading } = useListInventoryMovements({
    search: search || undefined,
    movementType: typeFilter !== "all" ? typeFilter : undefined,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    limit: 100,
  });

  const rows = movements?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search item, ref…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="All Types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {["receipt","despatch","adjustment","transfer","issue","return","repack","build"].map((t) => (
              <SelectItem key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input type="date" className="w-40" value={fromDate} onChange={(e) => setFromDate(e.target.value)} placeholder="From date" />
        <Input type="date" className="w-40" value={toDate} onChange={(e) => setToDate(e.target.value)} placeholder="To date" />
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-muted-foreground">Loading movements…</div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>Lot</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit Cost</TableHead>
                <TableHead>Ref</TableHead>
                <TableHead>By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">No movements found</TableCell></TableRow>
              ) : rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs">{fmtDate(r.createdAt)}</TableCell>
                  <TableCell><MovementBadge type={r.movementType ?? ""} /></TableCell>
                  <TableCell>
                    <div className="font-medium text-sm">{r.itemCode}</div>
                    <div className="text-xs text-muted-foreground">{r.itemName}</div>
                  </TableCell>
                  <TableCell className="text-sm">{r.warehouseName}</TableCell>
                  <TableCell className="text-xs">{r.lotNumber ?? "—"}</TableCell>
                  <TableCell className={`text-right font-mono font-semibold ${Number(r.quantity) < 0 ? "text-red-600" : "text-green-700"}`}>
                    {Number(r.quantity) > 0 ? "+" : ""}{fmt(r.quantity, 4)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">{r.unitCost ? `$${fmt(r.unitCost)}` : "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.refCode ?? r.refType ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{r.postedByEmail?.split("@")[0] ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ── Adjustments Tab ───────────────────────────────────────────────────────────

type AdjLine = { itemId: number; itemCode: string; warehouseId: number; locationId?: number; lotNumber?: string; qtyAdjusted: number; unitCost?: number; };
type AdjForm = { adjustmentType: "increase" | "decrease" | "recount"; reason: string; glAccountId: number; notes?: string; lines: AdjLine[]; };

function AdjustmentsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data: list, isLoading } = useListInventoryAdjustments({ limit: 50 });
  const { data: detail } = useGetInventoryAdjustment(detailId!, { query: { enabled: detailId !== null, queryKey: getGetInventoryAdjustmentQueryKey(detailId!) } });
  const { data: items } = useListItems({ limit: 500 });
  const { data: warehouses } = useListWarehouses({ limit: 100 });
  const { data: glAccounts } = useListGlAccounts({ limit: 500 });
  const createMut = useCreateInventoryAdjustment();

  const form = useForm<AdjForm>({
    defaultValues: { adjustmentType: "increase", reason: "", glAccountId: 0, lines: [{ itemId: 0, itemCode: "", warehouseId: 0, qtyAdjusted: 0 }] },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "lines" });

  const invalidate = () => qc.invalidateQueries({ queryKey: getListInventoryAdjustmentsQueryKey() });

  async function onSubmit(vals: AdjForm) {
    try {
      await createMut.mutateAsync({ data: { ...vals, lines: vals.lines.map((l) => ({ ...l, itemId: Number(l.itemId), warehouseId: Number(l.warehouseId) })) } });
      toast({ title: "Adjustment posted" });
      setShowCreate(false);
      form.reset({ adjustmentType: "increase", reason: "", glAccountId: 0, lines: [{ itemId: 0, itemCode: "", warehouseId: 0, qtyAdjusted: 0 }] });
      invalidate();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  }

  const rows = list?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <h3 className="text-lg font-semibold">Inventory Adjustments</h3>
        <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4 mr-2" />New Adjustment</Button>
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-muted-foreground">Loading…</div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Posted By</TableHead>
                <TableHead>Date</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No adjustments yet</TableCell></TableRow>
              ) : rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono font-medium">{r.code}</TableCell>
                  <TableCell className="capitalize">{r.adjustmentType}</TableCell>
                  <TableCell>{r.reason}</TableCell>
                  <TableCell><StatusBadge status={r.status ?? "draft"} /></TableCell>
                  <TableCell className="text-sm">{r.postedByEmail?.split("@")[0] ?? "—"}</TableCell>
                  <TableCell className="text-sm">{fmtDate(r.postedAt ?? r.createdAt)}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => setDetailId(r.id ?? null)}>
                      <Eye className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create Adjustment Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>New Stock Adjustment</DialogTitle></DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Type</Label>
                <Select value={form.watch("adjustmentType")} onValueChange={(v) => form.setValue("adjustmentType", v as AdjForm["adjustmentType"])}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="increase">Increase</SelectItem>
                    <SelectItem value="decrease">Decrease</SelectItem>
                    <SelectItem value="recount">Recount</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Reason *</Label>
                <Input {...form.register("reason", { required: true })} placeholder="e.g. Damaged goods, cycle count variance" />
              </div>
            </div>
            <div>
              <Label>GL Account *</Label>
              <Select value={form.watch("glAccountId") ? String(form.watch("glAccountId")) : ""} onValueChange={(v) => form.setValue("glAccountId", Number(v))}>
                <SelectTrigger><SelectValue placeholder="Select GL account…" /></SelectTrigger>
                <SelectContent>{(glAccounts?.accounts ?? []).map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.code} — {a.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea {...form.register("notes")} rows={2} />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Lines</Label>
                <Button type="button" size="sm" variant="outline" onClick={() => append({ itemId: 0, itemCode: "", warehouseId: 0, qtyAdjusted: 0 })}>
                  <Plus className="h-3 w-3 mr-1" />Add Line
                </Button>
              </div>
              {fields.map((field, i) => (
                <div key={field.id} className="grid grid-cols-12 gap-2 items-end">
                  <div className="col-span-4">
                    {i === 0 && <Label className="text-xs">Item</Label>}
                    <Select value={String(form.watch(`lines.${i}.itemId`))} onValueChange={(v) => {
                      const item = items?.items?.find((it) => it.id === Number(v));
                      form.setValue(`lines.${i}.itemId`, Number(v));
                      form.setValue(`lines.${i}.itemCode`, item?.code ?? "");
                    }}>
                      <SelectTrigger><SelectValue placeholder="Select item" /></SelectTrigger>
                      <SelectContent>{(items?.items ?? []).map((it) => <SelectItem key={it.id} value={String(it.id)}>{it.code} — {it.name}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-3">
                    {i === 0 && <Label className="text-xs">Warehouse</Label>}
                    <Select value={String(form.watch(`lines.${i}.warehouseId`))} onValueChange={(v) => form.setValue(`lines.${i}.warehouseId`, Number(v))}>
                      <SelectTrigger><SelectValue placeholder="Warehouse" /></SelectTrigger>
                      <SelectContent>{(warehouses?.warehouses ?? []).map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-2">
                    {i === 0 && <Label className="text-xs">Qty (±)</Label>}
                    <Input type="number" step="0.0001" {...form.register(`lines.${i}.qtyAdjusted`, { valueAsNumber: true })} placeholder="0" />
                  </div>
                  <div className="col-span-2">
                    {i === 0 && <Label className="text-xs">Unit Cost</Label>}
                    <Input type="number" step="0.01" {...form.register(`lines.${i}.unitCost`, { valueAsNumber: true })} placeholder="0.00" />
                  </div>
                  <div className="col-span-1">
                    {i === 0 && <Label className="text-xs invisible">Del</Label>}
                    <Button type="button" size="sm" variant="ghost" onClick={() => remove(i)} className="text-destructive w-full">✕</Button>
                  </div>
                </div>
              ))}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="submit" disabled={createMut.isPending}>{createMut.isPending ? "Posting…" : "Post Adjustment"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Detail Dialog */}
      <Dialog open={detailId !== null} onOpenChange={(o) => !o && setDetailId(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Adjustment {detail?.code}</DialogTitle></DialogHeader>
          {detail && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div><span className="text-muted-foreground">Type: </span>{detail.adjustmentType}</div>
                <div><span className="text-muted-foreground">Status: </span><StatusBadge status={detail.status ?? "draft"} /></div>
                <div className="col-span-2"><span className="text-muted-foreground">Reason: </span>{detail.reason}</div>
              </div>
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead>Warehouse</TableHead>
                      <TableHead>Lot</TableHead>
                      <TableHead className="text-right">Qty Adjusted</TableHead>
                      <TableHead className="text-right">Unit Cost</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {((detail as InventoryAdjustment)?.lines ?? []).map((l: InventoryAdjustmentLinesItem, i) => (
                      <TableRow key={i}>
                        <TableCell>{l.itemCode}</TableCell>
                        <TableCell>{l.warehouseId}</TableCell>
                        <TableCell>{l.lotNumber ?? "—"}</TableCell>
                        <TableCell className={`text-right font-mono font-semibold ${Number(l.qtyAdjusted) < 0 ? "text-red-600" : "text-green-700"}`}>
                          {Number(l.qtyAdjusted) > 0 ? "+" : ""}{fmt(l.qtyAdjusted, 4)}
                        </TableCell>
                        <TableCell className="text-right font-mono">{l.unitCost ? `$${fmt(l.unitCost)}` : "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Transfers Tab ─────────────────────────────────────────────────────────────

type TransferForm = { itemId: number; fromWarehouseId: number; toWarehouseId: number; quantity: number; lotNumber?: string; notes?: string; };

function TransfersTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: items } = useListItems({ limit: 500 });
  const { data: warehouses } = useListWarehouses({ limit: 100 });
  const { data: transfers, isLoading } = useListInventoryTransfers({
    status: statusFilter !== "all" ? (statusFilter as "in_transit" | "received" | "cancelled") : undefined,
    limit: 100,
  });
  const createMut = useCreateInventoryTransfer();
  const receiveMut = useReceiveInventoryTransfer();

  const form = useForm<TransferForm>({ defaultValues: { quantity: 0 } });

  async function onSubmit(vals: TransferForm) {
    try {
      const res = await createMut.mutateAsync({ data: { ...vals, itemId: Number(vals.itemId), fromWarehouseId: Number(vals.fromWarehouseId), toWarehouseId: Number(vals.toWarehouseId) } });
      toast({ title: `Transfer ${(res as CreateInventoryTransfer201).transferCode} created` });
      setShowCreate(false);
      form.reset();
      qc.invalidateQueries({ queryKey: getListInventoryTransfersQueryKey() });
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function handleReceive(id: number) {
    try {
      await receiveMut.mutateAsync({ id, data: {} });
      toast({ title: "Transfer received", description: "Inbound stock movement posted." });
      qc.invalidateQueries({ queryKey: getListInventoryTransfersQueryKey() });
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  }

  const rows = transfers?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-between flex-wrap gap-2">
        <div className="flex gap-2 items-center">
          <h3 className="text-lg font-semibold">Transfers</h3>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-36 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="in_transit">In Transit</SelectItem>
              <SelectItem value="received">Received</SelectItem>
              <SelectItem value="cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setShowCreate(true)}><ArrowLeftRight className="h-4 w-4 mr-2" />New Transfer</Button>
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-muted-foreground">Loading…</div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No transfers yet</TableCell></TableRow>
              ) : rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs">{fmtDate(r.createdAt)}</TableCell>
                  <TableCell className="text-sm">{String(r.itemId ?? "—")}</TableCell>
                  <TableCell className="text-sm">{String(r.fromWarehouseId ?? "—")}</TableCell>
                  <TableCell className="text-sm">{String(r.toWarehouseId ?? "—")}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(r.quantity, 4)}</TableCell>
                  <TableCell>
                    <Badge variant={r.status === "in_transit" ? "secondary" : r.status === "received" ? "default" : "outline"} className="text-xs">
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {r.status === "in_transit" && (
                      <Button size="sm" variant="outline" disabled={receiveMut.isPending} onClick={() => handleReceive(r.id ?? 0)}>
                        <CheckCircle2 className="h-3 w-3 mr-1" />Receive
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>New Stock Transfer</DialogTitle></DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <Label>Item *</Label>
              <Select value={String(form.watch("itemId") || "")} onValueChange={(v) => form.setValue("itemId", Number(v))}>
                <SelectTrigger><SelectValue placeholder="Select item" /></SelectTrigger>
                <SelectContent>{(items?.items ?? []).map((it) => <SelectItem key={it.id} value={String(it.id)}>{it.code} — {it.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>From Warehouse *</Label>
                <Select value={String(form.watch("fromWarehouseId") || "")} onValueChange={(v) => form.setValue("fromWarehouseId", Number(v))}>
                  <SelectTrigger><SelectValue placeholder="From" /></SelectTrigger>
                  <SelectContent>{(warehouses?.warehouses ?? []).map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label>To Warehouse *</Label>
                <Select value={String(form.watch("toWarehouseId") || "")} onValueChange={(v) => form.setValue("toWarehouseId", Number(v))}>
                  <SelectTrigger><SelectValue placeholder="To" /></SelectTrigger>
                  <SelectContent>{(warehouses?.warehouses ?? []).map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Quantity *</Label>
                <Input type="number" step="0.0001" {...form.register("quantity", { valueAsNumber: true, min: 0.0001 })} />
              </div>
              <div>
                <Label>Lot Number</Label>
                <Input {...form.register("lotNumber")} placeholder="Optional" />
              </div>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea {...form.register("notes")} rows={2} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="submit" disabled={createMut.isPending}>{createMut.isPending ? "Transferring…" : "Post Transfer"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Issues Tab ────────────────────────────────────────────────────────────────

type IssueForm = { itemId: number; warehouseId: number; quantity: number; glAccountId: number; lotNumber?: string; notes?: string; };

function IssuesTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);

  const { data: items } = useListItems({ limit: 500 });
  const { data: warehouses } = useListWarehouses({ limit: 100 });
  const { data: glAccounts } = useListGlAccounts({ limit: 200 });
  const { data: movements, isLoading } = useListInventoryMovements({ movementType: "issue", limit: 100 });
  const createMut = useCreateInventoryIssue();

  const form = useForm<IssueForm>({ defaultValues: { quantity: 0 } });

  async function onSubmit(vals: IssueForm) {
    try {
      await createMut.mutateAsync({ data: { ...vals, itemId: Number(vals.itemId), warehouseId: Number(vals.warehouseId), glAccountId: Number(vals.glAccountId) } });
      toast({ title: "Stock issue posted" });
      setShowCreate(false);
      form.reset();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  }

  const rows = movements?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <h3 className="text-lg font-semibold">Stock Issues</h3>
        <Button onClick={() => setShowCreate(true)}><SendToBack className="h-4 w-4 mr-2" />Issue Stock</Button>
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-muted-foreground">Loading…</div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead className="text-right">Qty Issued</TableHead>
                <TableHead>GL Account</TableHead>
                <TableHead>Lot</TableHead>
                <TableHead>By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8">No issues posted yet</TableCell></TableRow>
              ) : rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-xs">{fmtDate(r.createdAt)}</TableCell>
                  <TableCell>
                    <div className="font-medium text-sm">{r.itemCode}</div>
                    <div className="text-xs text-muted-foreground">{r.itemName}</div>
                  </TableCell>
                  <TableCell className="text-sm">{r.warehouseName}</TableCell>
                  <TableCell className="text-right font-mono text-red-600">{fmt(Math.abs(Number(r.quantity)), 4)}</TableCell>
                  <TableCell className="text-xs font-mono">{r.adjReason ?? "—"}</TableCell>
                  <TableCell className="text-xs">{r.lotNumber ?? "—"}</TableCell>
                  <TableCell className="text-xs">{r.postedByEmail?.split("@")[0] ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Issue Stock to GL Account</DialogTitle></DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div>
              <Label>Item *</Label>
              <Select value={String(form.watch("itemId") || "")} onValueChange={(v) => form.setValue("itemId", Number(v))}>
                <SelectTrigger><SelectValue placeholder="Select item" /></SelectTrigger>
                <SelectContent>{(items?.items ?? []).map((it) => <SelectItem key={it.id} value={String(it.id)}>{it.code} — {it.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Warehouse *</Label>
                <Select value={String(form.watch("warehouseId") || "")} onValueChange={(v) => form.setValue("warehouseId", Number(v))}>
                  <SelectTrigger><SelectValue placeholder="Warehouse" /></SelectTrigger>
                  <SelectContent>{(warehouses?.warehouses ?? []).map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label>Quantity *</Label>
                <Input type="number" step="0.0001" {...form.register("quantity", { valueAsNumber: true, min: 0.0001 })} />
              </div>
            </div>
            <div>
              <Label>GL Account *</Label>
              <Select value={String(form.watch("glAccountId") || "")} onValueChange={(v) => form.setValue("glAccountId", Number(v))}>
                <SelectTrigger><SelectValue placeholder="Select GL account" /></SelectTrigger>
                <SelectContent>{(glAccounts?.accounts ?? []).map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.code} — {a.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Lot Number</Label>
                <Input {...form.register("lotNumber")} placeholder="Optional" />
              </div>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea {...form.register("notes")} rows={2} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="submit" disabled={createMut.isPending}>{createMut.isPending ? "Posting…" : "Post Issue"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Stocktake Tab ─────────────────────────────────────────────────────────────

function StocktakeTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [editingLine, setEditingLine] = useState<{ lineId: number; currentQty: string } | null>(null);
  const [countedQty, setCountedQty] = useState("");

  const { data: list, isLoading } = useListStocktakeRuns({ limit: 50 });
  const { data: detail, refetch: refetchDetail } = useGetStocktakeRun(detailId!, { query: { enabled: detailId !== null, queryKey: getGetStocktakeRunQueryKey(detailId!) } });
  const { data: warehouses } = useListWarehouses({ limit: 100 });
  const createMut = useCreateStocktakeRun();
  const updateLineMut = useUpdateStocktakeLine();
  const postMut = usePostStocktakeRun();

  const form = useForm({ defaultValues: { warehouseId: 0, notes: "" } });

  const invalidate = () => qc.invalidateQueries({ queryKey: getListStocktakeRunsQueryKey() });

  async function onCreate(vals: { warehouseId: number; notes: string }) {
    try {
      const res = await createMut.mutateAsync({ data: { warehouseId: Number(vals.warehouseId), notes: vals.notes || undefined } });
      toast({ title: `Stocktake ${(res as CreateStocktakeRun201).code} created with ${(res as CreateStocktakeRun201).lineCount} lines` });
      setShowCreate(false);
      form.reset();
      invalidate();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function onSaveCount() {
    if (!editingLine || detailId === null) return;
    try {
      await updateLineMut.mutateAsync({ id: detailId, lineId: editingLine.lineId, data: { countedQty: Number(countedQty) } });
      setEditingLine(null);
      setCountedQty("");
      refetchDetail();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function onPost() {
    if (detailId === null) return;
    try {
      const res = await postMut.mutateAsync({ id: detailId, data: {} });
      toast({ title: `Stocktake posted — ${(res as PostStocktakeRun200).movementsPosted} variances adjusted` });
      setDetailId(null);
      invalidate();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  }

  const rows = list?.data ?? [];
  const lines: StocktakeLine[] = (detail as StocktakeRun | undefined)?.lines ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <h3 className="text-lg font-semibold">Stocktake Runs</h3>
        <Button onClick={() => setShowCreate(true)}><ClipboardList className="h-4 w-4 mr-2" />New Stocktake</Button>
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-muted-foreground">Loading…</div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Counted</TableHead>
                <TableHead>Posted</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No stocktake runs yet</TableCell></TableRow>
              ) : rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono font-medium">{r.code}</TableCell>
                  <TableCell>{r.warehouseName}</TableCell>
                  <TableCell><StatusBadge status={r.status ?? "unknown"} /></TableCell>
                  <TableCell className="text-sm">{fmtDate(r.countedAt)}</TableCell>
                  <TableCell className="text-sm">{fmtDate(r.postedAt)}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => setDetailId(r.id ?? null)}>
                      <Eye className="h-4 w-4 mr-1" />Manage
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Stocktake Run</DialogTitle></DialogHeader>
          <form onSubmit={form.handleSubmit(onCreate)} className="space-y-4">
            <div>
              <Label>Warehouse *</Label>
              <Select value={String(form.watch("warehouseId") || "")} onValueChange={(v) => form.setValue("warehouseId", Number(v))}>
                <SelectTrigger><SelectValue placeholder="Select warehouse" /></SelectTrigger>
                <SelectContent>{(warehouses?.warehouses ?? []).map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea {...form.register("notes")} rows={2} />
            </div>
            <p className="text-sm text-muted-foreground">This will freeze current system quantities for all stock in the selected warehouse.</p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="submit" disabled={createMut.isPending}>{createMut.isPending ? "Creating…" : "Create Run"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Detail / Count Dialog */}
      <Dialog open={detailId !== null} onOpenChange={(o) => !o && setDetailId(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {detail?.code} — {detail?.warehouseName}
              <StatusBadge status={(detail as { status?: string })?.status ?? "open"} />
            </DialogTitle>
          </DialogHeader>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Item</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Lot</TableHead>
                  <TableHead className="text-right">System Qty</TableHead>
                  <TableHead className="text-right">Counted Qty</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-4">No lines</TableCell></TableRow>
                ) : lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      <div className="text-sm font-medium">{l.itemCode}</div>
                      <div className="text-xs text-muted-foreground">{l.itemName}</div>
                    </TableCell>
                    <TableCell className="text-sm">{l.locationId ?? "—"}</TableCell>
                    <TableCell className="text-xs">{l.lotNumber ?? "—"}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(l.systemQty, 4)}</TableCell>
                    <TableCell className="text-right font-mono">
                      {editingLine?.lineId === l.id ? (
                        <div className="flex gap-1">
                          <Input type="number" step="0.0001" value={countedQty} onChange={(e) => setCountedQty(e.target.value)} className="w-24 h-7 text-xs" />
                          <Button size="sm" className="h-7 text-xs" onClick={onSaveCount}>✓</Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingLine(null)}>✕</Button>
                        </div>
                      ) : (
                        l.countedQty != null ? fmt(l.countedQty, 4) : <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className={`text-right font-mono text-sm ${Number(l.varianceQty ?? 0) < 0 ? "text-red-600" : Number(l.varianceQty ?? 0) > 0 ? "text-green-700" : ""}`}>
                      {l.varianceQty != null ? (Number(l.varianceQty) > 0 ? "+" : "") + fmt(l.varianceQty, 4) : "—"}
                    </TableCell>
                    <TableCell>
                      {(detail as { status?: string })?.status !== "posted" && (
                        <Button size="sm" variant="ghost" onClick={() => { setEditingLine({ lineId: l.id ?? 0, currentQty: l.countedQty ?? l.systemQty ?? "" }); setCountedQty(l.countedQty ?? l.systemQty ?? ""); }}>
                          Edit
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {(detail as { status?: string })?.status !== "posted" && (
            <DialogFooter>
              <Button variant="outline" onClick={() => setDetailId(null)}>Close</Button>
              <Button onClick={onPost} disabled={postMut.isPending}>
                {postMut.isPending ? "Posting…" : "Post Variances as Adjustments"}
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Cycle Counts Tab ──────────────────────────────────────────────────────────

function CycleCountsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");

  const { data: list, isLoading } = useListCycleCounts({ status: statusFilter !== "all" ? statusFilter : undefined, limit: 50 });
  const { data: detail, refetch: refetchDetail } = useGetCycleCount(detailId!, { query: { enabled: detailId !== null, queryKey: getGetCycleCountQueryKey(detailId!) } });
  const { data: warehouses } = useListWarehouses({ limit: 100 });
  const createMut = useCreateCycleCount();
  const updateMut = useUpdateCycleCount();
  const updateLineMut = useUpdateCycleCountLine();

  const form = useForm({ defaultValues: { warehouseId: 0, notes: "", assignedToName: "", dueDate: "" } });

  const invalidate = () => qc.invalidateQueries({ queryKey: getListCycleCountsQueryKey() });

  async function onCreate(vals: { warehouseId: number; notes: string; assignedToName: string; dueDate: string }) {
    try {
      const res = await createMut.mutateAsync({ data: { warehouseId: Number(vals.warehouseId), notes: vals.notes || undefined, assignedToName: vals.assignedToName || undefined, dueDate: vals.dueDate || undefined } });
      toast({ title: `Cycle count ${(res as CreateCycleCount201).code} created` });
      setShowCreate(false);
      form.reset();
      invalidate();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function onComplete() {
    if (!detailId) return;
    try {
      await updateMut.mutateAsync({ id: detailId, data: { status: "completed" } });
      toast({ title: "Cycle count completed" });
      setDetailId(null);
      invalidate();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function onUpdateLine(lineId: number, qty: string) {
    if (!detailId) return;
    try {
      await updateLineMut.mutateAsync({ id: detailId, lineId, data: { countedQty: Number(qty) } });
      refetchDetail();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  }

  const rows = list?.data ?? [];
  const lines: CycleCountTaskLinesItem[] = (detail as CycleCountTask | undefined)?.lines ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <div className="flex gap-2">
          <h3 className="text-lg font-semibold">Cycle Counts</h3>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-36 h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="in_progress">In Progress</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4 mr-2" />New Count</Button>
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-muted-foreground">Loading…</div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>Assigned To</TableHead>
                <TableHead>Due Date</TableHead>
                <TableHead>Status</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No cycle counts yet</TableCell></TableRow>
              ) : rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono font-medium">{r.code}</TableCell>
                  <TableCell>{r.warehouseName}</TableCell>
                  <TableCell className="text-sm">{r.assignedToName ?? "—"}</TableCell>
                  <TableCell className="text-sm">{fmtDate(r.dueDate)}</TableCell>
                  <TableCell><StatusBadge status={r.status ?? "unknown"} /></TableCell>
                  <TableCell>
                    <Button size="sm" variant="ghost" onClick={() => setDetailId(r.id ?? null)}>
                      <Eye className="h-4 w-4 mr-1" />Count
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Cycle Count Task</DialogTitle></DialogHeader>
          <form onSubmit={form.handleSubmit(onCreate)} className="space-y-4">
            <div>
              <Label>Warehouse *</Label>
              <Select value={String(form.watch("warehouseId") || "")} onValueChange={(v) => form.setValue("warehouseId", Number(v))}>
                <SelectTrigger><SelectValue placeholder="Select warehouse" /></SelectTrigger>
                <SelectContent>{(warehouses?.warehouses ?? []).map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Assigned To</Label>
                <Input {...form.register("assignedToName")} placeholder="Name" />
              </div>
              <div>
                <Label>Due Date</Label>
                <Input type="date" {...form.register("dueDate")} />
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="submit" disabled={createMut.isPending}>{createMut.isPending ? "Creating…" : "Create Task"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Count Lines Dialog */}
      <Dialog open={detailId !== null} onOpenChange={(o) => !o && setDetailId(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {(detail as { code?: string })?.code} — Cycle Count
              <StatusBadge status={(detail as { status?: string })?.status ?? "pending"} />
            </DialogTitle>
          </DialogHeader>
          <CycleCountLines lines={lines} onUpdateLine={onUpdateLine} status={(detail as { status?: string })?.status ?? "pending"} />
          {(detail as { status?: string })?.status !== "completed" && (
            <DialogFooter>
              <Button variant="outline" onClick={() => setDetailId(null)}>Close</Button>
              <Button onClick={onComplete} disabled={updateMut.isPending}>Mark Completed</Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CycleCountLines({ lines, onUpdateLine, status }: { lines: Array<{ id?: number; itemCode?: string | null; itemName?: string | null; lotNumber?: string | null; systemQty?: string; countedQty?: string | null; varianceQty?: string | null }>; onUpdateLine: (lineId: number, qty: string) => void; status: string }) {
  const [editing, setEditing] = useState<{ id: number; qty: string } | null>(null);
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Item</TableHead>
            <TableHead>Lot</TableHead>
            <TableHead className="text-right">System</TableHead>
            <TableHead className="text-right">Counted</TableHead>
            <TableHead className="text-right">Variance</TableHead>
            {status !== "completed" && <TableHead></TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {lines.length === 0 ? (
            <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-4">No lines</TableCell></TableRow>
          ) : lines.map((l) => (
            <TableRow key={l.id}>
              <TableCell>
                <div className="text-sm font-medium">{l.itemCode}</div>
                <div className="text-xs text-muted-foreground">{l.itemName}</div>
              </TableCell>
              <TableCell className="text-xs">{l.lotNumber ?? "—"}</TableCell>
              <TableCell className="text-right font-mono text-sm">{fmt(l.systemQty, 4)}</TableCell>
              <TableCell className="text-right font-mono text-sm">
                {editing !== null && editing.id === l.id ? (
                  <div className="flex gap-1 justify-end">
                    <Input type="number" step="0.0001" value={editing.qty} onChange={(e) => setEditing({ id: l.id ?? 0, qty: e.target.value })} className="w-24 h-7 text-xs" />
                    <Button size="sm" className="h-7 text-xs" onClick={() => { onUpdateLine(l.id ?? 0, editing.qty); setEditing(null); }}>✓</Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditing(null)}>✕</Button>
                  </div>
                ) : l.countedQty != null ? fmt(l.countedQty, 4) : <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell className={`text-right font-mono text-sm ${Number(l.varianceQty ?? 0) < 0 ? "text-red-600" : Number(l.varianceQty ?? 0) > 0 ? "text-green-700" : ""}`}>
                {l.varianceQty != null ? (Number(l.varianceQty) > 0 ? "+" : "") + fmt(l.varianceQty, 4) : "—"}
              </TableCell>
              {status !== "completed" && (
                <TableCell>
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ id: l.id ?? 0, qty: l.countedQty ?? l.systemQty ?? "" })}>Edit</Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── Lots Tab ──────────────────────────────────────────────────────────────────

function LotsTab() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [traceLot, setTraceLot] = useState<string | null>(null);
  const [traceDirection, setTraceDirection] = useState<"forward" | "backward">("forward");

  const { data: lots, isLoading } = useListLotNumbers({
    search: search || undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
    limit: 100,
  });

  const { data: trace, isLoading: traceLoading } = useTraceLotNumber(
    traceLot ?? "",
    { direction: traceDirection },
    { query: { enabled: traceLot !== null, queryKey: [...getTraceLotNumberQueryKey(traceLot ?? ""), traceDirection] } },
  );

  const rows = lots?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Search lots…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="All Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="consumed">Consumed</SelectItem>
            <SelectItem value="quarantine">Quarantine</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          {isLoading ? (
            <div className="py-8 text-center text-muted-foreground">Loading lots…</div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Lot #</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">On Hand</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No lots found</TableCell></TableRow>
                  ) : rows.map((r) => (
                    <TableRow key={r.id} className={traceLot === r.lotNumber ? "bg-muted" : ""}>
                      <TableCell className="font-mono text-sm">{r.lotNumber}</TableCell>
                      <TableCell>
                        <div className="text-sm font-medium">{r.itemCode}</div>
                        <div className="text-xs text-muted-foreground">{r.itemName}</div>
                      </TableCell>
                      <TableCell><StatusBadge status={r.status ?? "unknown"} /></TableCell>
                      <TableCell className="text-right font-mono">{fmt(r.qtyOnHand, 4)}</TableCell>
                      <TableCell className="text-xs">{fmtDate(r.expiryDate)}</TableCell>
                      <TableCell>
                        <Button size="sm" variant="ghost" onClick={() => setTraceLot(traceLot === r.lotNumber ? null : (r.lotNumber ?? null))}>
                          <Activity className="h-3 w-3 mr-1" />Trace
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {traceLot && (
          <div className="space-y-2">
            <div className="flex items-center gap-3 flex-wrap">
              <h4 className="font-semibold flex items-center gap-2">
                <Tag className="h-4 w-4" />Trace: {traceLot}
              </h4>
              <Select value={traceDirection} onValueChange={(v) => setTraceDirection(v as "forward" | "backward")}>
                <SelectTrigger className="w-32 h-7 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="forward">Forward</SelectItem>
                  <SelectItem value="backward">Backward</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {traceLoading ? (
              <div className="py-4 text-center text-muted-foreground">Loading trace…</div>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Warehouse</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead>Ref</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(trace?.movements ?? []).length === 0 ? (
                      <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-4">No movements for this lot</TableCell></TableRow>
                    ) : (trace?.movements ?? []).map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="text-xs">{fmtDate(m.createdAt)}</TableCell>
                        <TableCell><MovementBadge type={m.movementType ?? ""} /></TableCell>
                        <TableCell className="text-sm">{m.warehouseName}</TableCell>
                        <TableCell className={`text-right font-mono text-sm font-semibold ${Number(m.quantity) < 0 ? "text-red-600" : "text-green-700"}`}>
                          {Number(m.quantity) > 0 ? "+" : ""}{fmt(m.quantity, 4)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{m.refCode ?? m.refType ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Serial Numbers Tab ────────────────────────────────────────────────────────

type SerialRegisterForm = { serialNumber: string; itemId?: number; warehouseId?: number; lotNumber?: string; status?: string; notes?: string };

function SerialNumbersTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedSn, setSelectedSn] = useState<string | null>(null);
  const [showRegister, setShowRegister] = useState(false);

  const { data: items } = useListItems({ limit: 500 });
  const { data: warehouses } = useListWarehouses({ limit: 100 });
  const { data: serials, isLoading } = useListSerialNumbers({
    search: search || undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
    limit: 100,
  });
  const { data: detail, isLoading: detailLoading } = useGetSerialNumber(
    selectedSn ?? "",
    { query: { enabled: !!selectedSn, queryKey: getGetSerialNumberQueryKey(selectedSn ?? "") } },
  );
  const registerMut = useRegisterSerialNumber();
  const updateMut = useUpdateSerialNumber();

  const form = useForm<SerialRegisterForm>({ defaultValues: { status: "available" } });

  async function onRegister(vals: SerialRegisterForm) {
    try {
      await registerMut.mutateAsync({ data: { ...vals, itemId: vals.itemId ? Number(vals.itemId) : undefined, warehouseId: vals.warehouseId ? Number(vals.warehouseId) : undefined } });
      toast({ title: "Serial number registered" });
      setShowRegister(false);
      form.reset({ status: "available" });
      qc.invalidateQueries({ queryKey: getListSerialNumbersQueryKey() });
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function handleScrap(sn: string) {
    try {
      await updateMut.mutateAsync({ serialNumber: sn, data: { status: "scrapped" } });
      toast({ title: `${sn} marked as scrapped` });
      qc.invalidateQueries({ queryKey: getListSerialNumbersQueryKey() });
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  }

  const rows = serials?.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-between flex-wrap gap-2">
        <div className="flex gap-2 flex-1 flex-wrap">
          <div className="relative flex-1 min-w-48">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search serial numbers…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-36"><SelectValue placeholder="All Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="available">Available</SelectItem>
              <SelectItem value="sold">Sold</SelectItem>
              <SelectItem value="scrapped">Scrapped</SelectItem>
              <SelectItem value="quarantine">Quarantine</SelectItem>
              <SelectItem value="in_transit">In Transit</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setShowRegister(true)}><Plus className="h-4 w-4 mr-2" />Register Serial</Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          {isLoading ? (
            <div className="py-8 text-center text-muted-foreground">Loading…</div>
          ) : (
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Serial #</TableHead>
                    <TableHead>Item</TableHead>
                    <TableHead>Warehouse</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Lot</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">No serial numbers found</TableCell></TableRow>
                  ) : rows.map((r) => (
                    <TableRow key={r.id} className={selectedSn === r.serialNumber ? "bg-muted" : ""}>
                      <TableCell className="font-mono text-sm">{r.serialNumber}</TableCell>
                      <TableCell>
                        <div className="text-sm font-medium">{r.itemCode}</div>
                        <div className="text-xs text-muted-foreground">{r.itemName}</div>
                      </TableCell>
                      <TableCell className="text-sm">{r.warehouseName ?? "—"}</TableCell>
                      <TableCell><StatusBadge status={r.status ?? "unknown"} /></TableCell>
                      <TableCell className="text-xs">{r.lotNumber ?? "—"}</TableCell>
                      <TableCell className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setSelectedSn(selectedSn === r.serialNumber ? null : (r.serialNumber ?? null))}>
                          <Eye className="h-3 w-3 mr-1" />Trace
                        </Button>
                        {r.status === "available" && (
                          <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => handleScrap(r.serialNumber ?? "")}>
                            Scrap
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {selectedSn && (
          <div className="space-y-2">
            <h4 className="font-semibold flex items-center gap-2">
              <Hash className="h-4 w-4" />Trace: {selectedSn}
            </h4>
            {detailLoading ? (
              <div className="py-4 text-center text-muted-foreground">Loading…</div>
            ) : (
              <div className="rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Warehouse</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead>Ref</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(detail?.movements ?? []).length === 0 ? (
                      <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-4">No movements for this serial</TableCell></TableRow>
                    ) : (detail?.movements ?? []).map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="text-xs">{fmtDate(m.createdAt)}</TableCell>
                        <TableCell><MovementBadge type={m.movementType ?? ""} /></TableCell>
                        <TableCell className="text-sm">{m.warehouseName}</TableCell>
                        <TableCell className={`text-right font-mono text-sm font-semibold ${Number(m.quantity) < 0 ? "text-red-600" : "text-green-700"}`}>
                          {Number(m.quantity) > 0 ? "+" : ""}{fmt(m.quantity, 4)}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{m.refCode ?? m.refType ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog open={showRegister} onOpenChange={setShowRegister}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Register Serial Number</DialogTitle></DialogHeader>
          <form onSubmit={form.handleSubmit(onRegister)} className="space-y-4">
            <div>
              <Label>Serial Number *</Label>
              <Input {...form.register("serialNumber", { required: true })} placeholder="e.g. SN-2024-00001" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Item</Label>
                <Select value={String(form.watch("itemId") || "")} onValueChange={(v) => form.setValue("itemId", Number(v))}>
                  <SelectTrigger><SelectValue placeholder="Select item" /></SelectTrigger>
                  <SelectContent>{(items?.items ?? []).map((it) => <SelectItem key={it.id} value={String(it.id)}>{it.code}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <Label>Warehouse</Label>
                <Select value={String(form.watch("warehouseId") || "")} onValueChange={(v) => form.setValue("warehouseId", Number(v))}>
                  <SelectTrigger><SelectValue placeholder="Select warehouse" /></SelectTrigger>
                  <SelectContent>{(warehouses?.warehouses ?? []).map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Lot Number</Label>
                <Input {...form.register("lotNumber")} placeholder="Optional" />
              </div>
              <div>
                <Label>Status</Label>
                <Select value={form.watch("status") || "available"} onValueChange={(v) => form.setValue("status", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="available">Available</SelectItem>
                    <SelectItem value="quarantine">Quarantine</SelectItem>
                    <SelectItem value="sold">Sold</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Notes</Label>
              <Textarea {...form.register("notes")} rows={2} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowRegister(false)}>Cancel</Button>
              <Button type="submit" disabled={registerMut.isPending}>{registerMut.isPending ? "Registering…" : "Register"}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Direct Receive Tab ────────────────────────────────────────────────────────

type DirectReceiveForm = {
  itemId: number;
  warehouseId: number;
  locationId?: number;
  quantity: number;
  unitCost?: number;
  lotNumber?: string;
  serialNumber?: string;
  glAccountId: number;
  refCode?: string;
  notes?: string;
};

function DirectReceiveTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: items } = useListItems({ limit: 500 });
  const { data: warehouses } = useListWarehouses({ limit: 200 });
  const { data: glAccounts } = useListGlAccounts({ limit: 500 });
  const receiveMut = useCreateDirectReceive();

  const form = useForm<DirectReceiveForm>({ defaultValues: { quantity: 1, itemId: 0, warehouseId: 0, glAccountId: 0 } });

  async function onSubmit(vals: DirectReceiveForm) {
    await receiveMut.mutateAsync({
      data: {
        itemId: vals.itemId,
        warehouseId: vals.warehouseId,
        locationId: vals.locationId || undefined,
        quantity: vals.quantity,
        unitCost: vals.unitCost || undefined,
        lotNumber: vals.lotNumber || undefined,
        serialNumber: vals.serialNumber || undefined,
        glAccountId: vals.glAccountId,
        refCode: vals.refCode || undefined,
        notes: vals.notes || undefined,
      },
    });
    toast({ title: "Stock received successfully" });
    qc.invalidateQueries({ queryKey: getListInventoryMovementsQueryKey() });
    form.reset({ quantity: 1, itemId: 0, warehouseId: 0, glAccountId: 0 });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Direct Stock Receipt</h3>
          <p className="text-sm text-muted-foreground">Receive goods into stock directly (without a purchase order).</p>
        </div>
      </div>

      <form onSubmit={form.handleSubmit(onSubmit)} className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl border rounded-lg p-6">
        <div className="space-y-2">
          <Label>Item *</Label>
          <Select
            value={form.watch("itemId") ? String(form.watch("itemId")) : ""}
            onValueChange={(v) => form.setValue("itemId", Number(v))}
          >
            <SelectTrigger><SelectValue placeholder="Select item…" /></SelectTrigger>
            <SelectContent>{(items?.items ?? []).map((it) => <SelectItem key={it.id} value={String(it.id)}>{it.code} — {it.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Warehouse *</Label>
          <Select
            value={form.watch("warehouseId") ? String(form.watch("warehouseId")) : ""}
            onValueChange={(v) => form.setValue("warehouseId", Number(v))}
          >
            <SelectTrigger><SelectValue placeholder="Select warehouse…" /></SelectTrigger>
            <SelectContent>{(warehouses?.warehouses ?? []).map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Quantity *</Label>
          <Input type="number" min="0.0001" step="any" {...form.register("quantity", { valueAsNumber: true })} />
        </div>

        <div className="space-y-2">
          <Label>Unit Cost</Label>
          <Input type="number" min="0" step="any" placeholder="0.00" {...form.register("unitCost", { valueAsNumber: true })} />
        </div>

        <div className="space-y-2">
          <Label>Lot Number</Label>
          <Input placeholder="LOT-001" {...form.register("lotNumber")} />
        </div>

        <div className="space-y-2">
          <Label>Serial Number</Label>
          <Input placeholder="SN-001" {...form.register("serialNumber")} />
        </div>

        <div className="space-y-2">
          <Label>GL Clearing / AP Account *</Label>
          <Select
            value={form.watch("glAccountId") ? String(form.watch("glAccountId")) : ""}
            onValueChange={(v) => form.setValue("glAccountId", Number(v))}
          >
            <SelectTrigger><SelectValue placeholder="Select GL account…" /></SelectTrigger>
            <SelectContent>{(glAccounts?.accounts ?? []).map((a) => <SelectItem key={a.id} value={String(a.id)}>{a.code} — {a.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Reference Code</Label>
          <Input placeholder="RECV-001" {...form.register("refCode")} />
        </div>

        <div className="md:col-span-2 space-y-2">
          <Label>Notes</Label>
          <Textarea rows={2} {...form.register("notes")} />
        </div>

        <div className="md:col-span-2 flex justify-end">
          <Button type="submit" disabled={receiveMut.isPending}>
            <Truck className="h-4 w-4 mr-2" />
            {receiveMut.isPending ? "Posting…" : "Post Receipt"}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ── Repack / Build Tab ────────────────────────────────────────────────────────

type RepackFormData = { itemId: number; warehouseId: number; fromLotNumber?: string; toLotNumber?: string; qtyIn: number; qtyOut: number; unitCost?: number; notes?: string };
type BuildComponent = { itemId: number; qty: number; warehouseId: number; lotNumber?: string };
type BuildFormData = { finishedItemId: number; finishedQty: number; finishedWarehouseId: number; finishedLotNumber?: string; notes?: string; components: BuildComponent[] };

function RepackTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: items } = useListItems({ limit: 500 });
  const { data: warehouses } = useListWarehouses({ limit: 100 });
  const repackMut = useCreateInventoryRepack();
  const form = useForm<RepackFormData>({ defaultValues: { qtyIn: 1, qtyOut: 1, itemId: 0, warehouseId: 0 } });

  async function onSubmit(vals: RepackFormData) {
    try {
      await repackMut.mutateAsync({ data: {
        itemId: vals.itemId, warehouseId: vals.warehouseId,
        qtyIn: vals.qtyIn, qtyOut: vals.qtyOut,
        fromLotNumber: vals.fromLotNumber || undefined,
        toLotNumber: vals.toLotNumber || undefined,
        unitCost: vals.unitCost || undefined,
        notes: vals.notes || undefined,
      } });
      toast({ title: "Repack posted", description: `Consumed ${vals.qtyIn} → Produced ${vals.qtyOut}` });
      qc.invalidateQueries({ queryKey: getListInventoryMovementsQueryKey() });
      form.reset({ qtyIn: 1, qtyOut: 1, itemId: 0, warehouseId: 0 });
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 max-w-2xl">
      <p className="text-sm text-muted-foreground">Convert stock from one pack size or lot to another for the same item. Records paired OUT and IN movements of type "repack".</p>
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Item *</Label>
          <Select value={form.watch("itemId") ? String(form.watch("itemId")) : ""} onValueChange={(v) => form.setValue("itemId", Number(v))}>
            <SelectTrigger><SelectValue placeholder="Select item" /></SelectTrigger>
            <SelectContent>{(items?.items ?? []).map((it) => <SelectItem key={it.id} value={String(it.id)}>{it.code} — {it.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Warehouse *</Label>
          <Select value={form.watch("warehouseId") ? String(form.watch("warehouseId")) : ""} onValueChange={(v) => form.setValue("warehouseId", Number(v))}>
            <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
            <SelectContent>{(warehouses?.warehouses ?? []).map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>From Lot</Label>
          <Input {...form.register("fromLotNumber")} placeholder="Source lot (optional)" />
        </div>
        <div className="space-y-2">
          <Label>To Lot</Label>
          <Input {...form.register("toLotNumber")} placeholder="Destination lot (optional)" />
        </div>
        <div className="space-y-2">
          <Label>Qty Consumed *</Label>
          <Input type="number" step="0.0001" min="0.0001" {...form.register("qtyIn", { valueAsNumber: true })} />
        </div>
        <div className="space-y-2">
          <Label>Qty Produced *</Label>
          <Input type="number" step="0.0001" min="0.0001" {...form.register("qtyOut", { valueAsNumber: true })} />
        </div>
        <div className="space-y-2">
          <Label>Unit Cost</Label>
          <Input type="number" step="0.01" min="0" placeholder="0.00" {...form.register("unitCost", { valueAsNumber: true })} />
        </div>
        <div className="space-y-2">
          <Label>Notes</Label>
          <Input {...form.register("notes")} placeholder="Optional" />
        </div>
      </div>
      <Button type="submit" disabled={repackMut.isPending}>
        <PackageCheck className="h-4 w-4 mr-2" />{repackMut.isPending ? "Posting…" : "Post Repack"}
      </Button>
    </form>
  );
}

function BuildTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: items } = useListItems({ limit: 500 });
  const { data: warehouses } = useListWarehouses({ limit: 100 });
  const buildMut = useCreateInventoryBuild();
  const form = useForm<BuildFormData>({ defaultValues: { finishedQty: 1, finishedItemId: 0, finishedWarehouseId: 0, components: [{ itemId: 0, qty: 1, warehouseId: 0 }] } });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "components" });

  async function onSubmit(vals: BuildFormData) {
    try {
      await buildMut.mutateAsync({ data: {
        finishedItemId: vals.finishedItemId,
        finishedQty: vals.finishedQty,
        finishedWarehouseId: vals.finishedWarehouseId,
        finishedLotNumber: vals.finishedLotNumber || undefined,
        notes: vals.notes || undefined,
        components: vals.components.map((c) => ({ itemId: Number(c.itemId), qty: c.qty, warehouseId: Number(c.warehouseId), lotNumber: c.lotNumber || undefined })),
      } });
      toast({ title: "Build posted", description: `Produced ${vals.finishedQty} × finished item` });
      qc.invalidateQueries({ queryKey: getListInventoryMovementsQueryKey() });
      form.reset({ finishedQty: 1, finishedItemId: 0, finishedWarehouseId: 0, components: [{ itemId: 0, qty: 1, warehouseId: 0 }] });
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 max-w-3xl">
      <p className="text-sm text-muted-foreground">Build a kit or assembly by consuming component items and producing a finished item. Records "build" movements.</p>

      <div className="rounded-lg border p-4 space-y-3">
        <h4 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">Finished Item</h4>
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1">
            <Label>Item *</Label>
            <Select value={form.watch("finishedItemId") ? String(form.watch("finishedItemId")) : ""} onValueChange={(v) => form.setValue("finishedItemId", Number(v))}>
              <SelectTrigger><SelectValue placeholder="Select item" /></SelectTrigger>
              <SelectContent>{(items?.items ?? []).map((it) => <SelectItem key={it.id} value={String(it.id)}>{it.code} — {it.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Warehouse *</Label>
            <Select value={form.watch("finishedWarehouseId") ? String(form.watch("finishedWarehouseId")) : ""} onValueChange={(v) => form.setValue("finishedWarehouseId", Number(v))}>
              <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>{(warehouses?.warehouses ?? []).map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Qty *</Label>
            <Input type="number" step="0.0001" min="0.0001" {...form.register("finishedQty", { valueAsNumber: true })} />
          </div>
          <div className="space-y-1">
            <Label>Lot Number</Label>
            <Input {...form.register("finishedLotNumber")} placeholder="Optional" />
          </div>
          <div className="col-span-2 space-y-1">
            <Label>Notes</Label>
            <Input {...form.register("notes")} placeholder="Optional" />
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="font-medium text-sm text-muted-foreground uppercase tracking-wide">Components</h4>
          <Button type="button" size="sm" variant="outline" onClick={() => append({ itemId: 0, qty: 1, warehouseId: 0 })}>
            <Plus className="h-3 w-3 mr-1" />Add Component
          </Button>
        </div>
        {fields.map((field, i) => (
          <div key={field.id} className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-4">
              {i === 0 && <Label className="text-xs">Item</Label>}
              <Select value={form.watch(`components.${i}.itemId`) ? String(form.watch(`components.${i}.itemId`)) : ""} onValueChange={(v) => form.setValue(`components.${i}.itemId`, Number(v))}>
                <SelectTrigger><SelectValue placeholder="Select item" /></SelectTrigger>
                <SelectContent>{(items?.items ?? []).map((it) => <SelectItem key={it.id} value={String(it.id)}>{it.code} — {it.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="col-span-3">
              {i === 0 && <Label className="text-xs">Warehouse</Label>}
              <Select value={form.watch(`components.${i}.warehouseId`) ? String(form.watch(`components.${i}.warehouseId`)) : ""} onValueChange={(v) => form.setValue(`components.${i}.warehouseId`, Number(v))}>
                <SelectTrigger><SelectValue placeholder="Warehouse" /></SelectTrigger>
                <SelectContent>{(warehouses?.warehouses ?? []).map((w) => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              {i === 0 && <Label className="text-xs">Qty</Label>}
              <Input type="number" step="0.0001" min="0.0001" {...form.register(`components.${i}.qty`, { valueAsNumber: true })} />
            </div>
            <div className="col-span-2">
              {i === 0 && <Label className="text-xs">Lot</Label>}
              <Input {...form.register(`components.${i}.lotNumber`)} placeholder="Optional" />
            </div>
            <div className="col-span-1">
              {i === 0 && <Label className="text-xs invisible">Del</Label>}
              <Button type="button" size="sm" variant="ghost" onClick={() => remove(i)} className="text-destructive w-full">✕</Button>
            </div>
          </div>
        ))}
      </div>

      <Button type="submit" disabled={buildMut.isPending}>
        <PackageCheck className="h-4 w-4 mr-2" />{buildMut.isPending ? "Posting…" : "Post Build"}
      </Button>
    </form>
  );
}

function RepackBuildTab() {
  const [mode, setMode] = useState<"repack" | "build">("repack");
  return (
    <div className="space-y-4">
      <div className="flex gap-2 items-center">
        <h3 className="text-lg font-semibold">Repack / Build</h3>
        <div className="flex rounded-md border overflow-hidden text-sm">
          <button type="button" onClick={() => setMode("repack")} className={`px-3 py-1.5 ${mode === "repack" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>Repack</button>
          <button type="button" onClick={() => setMode("build")} className={`px-3 py-1.5 ${mode === "build" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>Build / Kit</button>
        </div>
      </div>
      {mode === "repack" ? <RepackTab /> : <BuildTab />}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function Inventory() {
  const [tab, setTab] = useState("stock");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Inventory</h2>
        <p className="text-muted-foreground">Multi-warehouse stock management, movements, and counting.</p>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="stock" className="gap-1.5">
            <Boxes className="h-4 w-4" />Stock
          </TabsTrigger>
          <TabsTrigger value="movements" className="gap-1.5">
            <Activity className="h-4 w-4" />Movements
          </TabsTrigger>
          <TabsTrigger value="adjustments" className="gap-1.5">
            <RefreshCw className="h-4 w-4" />Adjustments
          </TabsTrigger>
          <TabsTrigger value="transfers" className="gap-1.5">
            <ArrowLeftRight className="h-4 w-4" />Transfers
          </TabsTrigger>
          <TabsTrigger value="issues" className="gap-1.5">
            <SendToBack className="h-4 w-4" />Issues
          </TabsTrigger>
          <TabsTrigger value="stocktake" className="gap-1.5">
            <ClipboardList className="h-4 w-4" />Stocktake
          </TabsTrigger>
          <TabsTrigger value="cycle-counts" className="gap-1.5">
            <BarChart3 className="h-4 w-4" />Cycle Counts
          </TabsTrigger>
          <TabsTrigger value="lots" className="gap-1.5">
            <Tag className="h-4 w-4" />Lots
          </TabsTrigger>
          <TabsTrigger value="serials" className="gap-1.5">
            <Hash className="h-4 w-4" />Serials
          </TabsTrigger>
          <TabsTrigger value="receive" className="gap-1.5">
            <Truck className="h-4 w-4" />Receive
          </TabsTrigger>
          <TabsTrigger value="repack" className="gap-1.5">
            <PackageCheck className="h-4 w-4" />Repack/Build
          </TabsTrigger>
        </TabsList>

        <TabsContent value="stock"><StockDashboardTab /></TabsContent>
        <TabsContent value="movements"><MovementLogTab /></TabsContent>
        <TabsContent value="adjustments"><AdjustmentsTab /></TabsContent>
        <TabsContent value="transfers"><TransfersTab /></TabsContent>
        <TabsContent value="issues"><IssuesTab /></TabsContent>
        <TabsContent value="stocktake"><StocktakeTab /></TabsContent>
        <TabsContent value="cycle-counts"><CycleCountsTab /></TabsContent>
        <TabsContent value="lots"><LotsTab /></TabsContent>
        <TabsContent value="serials"><SerialNumbersTab /></TabsContent>
        <TabsContent value="receive"><DirectReceiveTab /></TabsContent>
        <TabsContent value="repack"><RepackBuildTab /></TabsContent>
      </Tabs>
    </div>
  );
}
