import { useState, useCallback, useEffect, useRef } from "react";
import * as XLSX from "xlsx";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useForm, Controller } from "react-hook-form";
import {
  useListItems,
  useCreateItem,
  useUpdateItem,
  useDeleteItem,
  getListItemsQueryKey,
  useListSuppliers,
  useCreateSupplier,
  useUpdateSupplier,
  useDeleteSupplier,
  getListSuppliersQueryKey,
  useListCustomers,
  useCreateCustomer,
  useUpdateCustomer,
  useDeleteCustomer,
  getListCustomersQueryKey,
  useListWarehouses,
  useCreateWarehouse,
  useUpdateWarehouse,
  useDeleteWarehouse,
  getListWarehousesQueryKey,
  useListGlAccounts,
  useCreateGlAccount,
  useUpdateGlAccount,
  useDeleteGlAccount,
  useImportGlAccountTemplate,
  getListGlAccountsQueryKey,
  useGetMasterDataAuditTrail,
  useListItemUnits,
  useCreateItemUnit,
  useDeleteItemUnit,
} from "@workspace/api-client-react";
import type {
  CreateItemBody,
  CreateItemUnitBody,
  CreateSupplierBody,
  CreateCustomerBody,
  CreateWarehouseBody,
  CreateGlAccountBody,
  ListItemsQueryResult,
  ListSuppliersQueryResult,
  ListCustomersQueryResult,
  ListWarehousesQueryResult,
  ListGlAccountsQueryResult,
  GlTemplateImportBodyTemplate,
  AuditTrailEntry,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  MoreHorizontal,
  Plus,
  Search,
  Pencil,
  Trash2,
  Package,
  Truck,
  Users,
  Warehouse,
  BookOpen,
  Download,
  History,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Loader2,
} from "lucide-react";

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmtDateTime(d: Date | string | null | undefined) {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(d));
}

function fmtCurrency(v: string | null | undefined) {
  if (!v) return "—";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
  }).format(Number(v));
}

function ActiveBadge({ active }: { active: boolean | undefined }) {
  return active ? (
    <Badge variant="default" className="bg-green-100 text-green-800 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-400">Active</Badge>
  ) : (
    <Badge variant="secondary">Inactive</Badge>
  );
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

function SortHeader({
  label,
  field,
  sort,
  onSort,
}: {
  label: string;
  field: string;
  sort: { field: string; dir: "asc" | "desc" };
  onSort: (f: string) => void;
}) {
  const active = sort.field === field;
  return (
    <button
      className="flex items-center gap-1 font-medium text-left hover:text-foreground transition-colors"
      onClick={() => onSort(field)}
    >
      {label}
      {active ? (
        sort.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
      ) : (
        <ArrowUpDown className="h-3 w-3 text-muted-foreground" />
      )}
    </button>
  );
}

function DeleteConfirm({
  open,
  onOpenChange,
  name,
  onConfirm,
  isPending,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  name: string;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Delete {name}?</DialogTitle>
          <DialogDescription>
            This action cannot be undone. The record will be soft-deleted and removed from all active views.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isPending}>
            {isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Audit Trail Dialog ───────────────────────────────────────────────────────

function AuditTrailDialog({
  open,
  onOpenChange,
  entityType,
  entityId,
  entityName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  entityType: string;
  entityId: string;
  entityName: string;
}) {
  const { data, isLoading } = useGetMasterDataAuditTrail({
    entityType: entityType as "item" | "supplier" | "customer" | "warehouse" | "gl_account",
    entityId,
    limit: 50,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Audit Trail — {entityName}</DialogTitle>
          <DialogDescription>All recorded changes to this record</DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded" />
            ))
          ) : !data?.entries?.length ? (
            <p className="text-sm text-muted-foreground text-center py-8">No audit history recorded yet.</p>
          ) : (
            data.entries.map((entry: AuditTrailEntry) => (
              <div key={entry.id} className="rounded-lg border p-3 text-sm space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-medium bg-muted px-1.5 py-0.5 rounded">{entry.action}</span>
                  <span className="text-xs text-muted-foreground">{fmtDateTime(entry.createdAt)}</span>
                </div>
                <p className="text-muted-foreground text-xs">
                  By {entry.actorEmail ?? entry.actorClerkId ?? "System"}
                </p>
                {Boolean(entry.newValues) && (
                  <details className="mt-1">
                    <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">View changes</summary>
                    <pre className="mt-1 text-xs bg-muted rounded p-2 overflow-x-auto max-h-32">
                      {JSON.stringify(entry.newValues as Record<string, unknown>, null, 2)}
                    </pre>
                  </details>
                )}
              </div>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── CSV Export ───────────────────────────────────────────────────────────────

function exportCSV(rows: Record<string, unknown>[], filename: string) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]!).filter(
    (k) => !["tenantId", "deletedAt"].includes(k),
  );
  const header = keys.join(",");
  const body = rows
    .map((r) =>
      keys
        .map((k) => {
          const v = r[k];
          if (v === null || v === undefined) return "";
          if (typeof v === "object") return `"${JSON.stringify(v).replace(/"/g, '""')}"`;
          const str = String(v);
          return str.includes(",") || str.includes('"') || str.includes("\n")
            ? `"${str.replace(/"/g, '""')}"`
            : str;
        })
        .join(","),
    )
    .join("\n");
  const blob = new Blob([`${header}\n${body}`], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function exportExcel(rows: Record<string, unknown>[], filename: string) {
  if (!rows.length) return;
  const filtered = rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (["tenantId", "deletedAt"].includes(k)) continue;
      out[k] = v instanceof Date ? v.toISOString() : (v === null ? "" : v);
    }
    return out;
  });
  const ws = XLSX.utils.json_to_sheet(filtered);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Data");
  XLSX.writeFile(wb, filename);
}

// ─── useInfiniteTable ─────────────────────────────────────────────────────────

interface SortState {
  field: string;
  dir: "asc" | "desc";
}

function useSortToggle(initial: SortState) {
  const [sort, setSort] = useState<SortState>(initial);
  const toggle = useCallback(
    (field: string) => {
      setSort((prev) =>
        prev.field === field
          ? { field, dir: prev.dir === "asc" ? "desc" : "asc" }
          : { field, dir: "asc" },
      );
    },
    [],
  );
  return { sort, toggle };
}

// ─── Item Units Panel ─────────────────────────────────────────────────────────

function ItemUnitsPanel({ itemId }: { itemId: number }) {
  const { toast } = useToast();
  const { data, refetch } = useListItemUnits(itemId);
  const createUnit = useCreateItemUnit();
  const deleteUnit = useDeleteItemUnit();

  const { register, handleSubmit, reset, formState: { errors } } = useForm<CreateItemUnitBody>({
    defaultValues: { unitCode: "", unitName: "", conversionFactor: 1, isBase: false },
  });

  const onSubmit = handleSubmit(async (d) => {
    try {
      await createUnit.mutateAsync({ itemId, data: d });
      toast({ title: "Unit added" });
      reset({ unitCode: "", unitName: "", conversionFactor: 1, isBase: false });
      refetch();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  });

  return (
    <div className="space-y-3 pt-2 border-t">
      <h4 className="text-sm font-semibold">Units of Measure</h4>
      {data?.units && data.units.length > 0 ? (
        <div className="rounded border divide-y text-sm">
          {data.units.map((u: { id?: number; unitCode?: string; unitName?: string; conversionFactor?: string; isBase?: boolean }) => (
            <div key={u.id} className="flex items-center justify-between px-3 py-1.5">
              <span className="font-mono font-medium">{u.unitCode}</span>
              <span className="text-muted-foreground text-xs ml-2">{u.unitName}</span>
              <span className="text-muted-foreground text-xs ml-auto">× {u.conversionFactor}</span>
              {u.isBase && <Badge variant="outline" className="text-xs ml-2">Base</Badge>}
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 ml-2"
                onClick={async () => {
                  await deleteUnit.mutateAsync({ itemId, unitId: u.id! });
                  refetch();
                }}
              >
                <Trash2 className="h-3 w-3 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No units defined yet.</p>
      )}
      <form onSubmit={onSubmit} className="flex gap-2 items-end">
        <div className="flex-1">
          <Label className="text-xs mb-1 block">Code (e.g. EA, KG)</Label>
          <Input {...register("unitCode", { required: true })} placeholder="EA" className="h-8 text-sm" />
          {errors.unitCode && <p className="text-xs text-destructive">Required</p>}
        </div>
        <div className="flex-1">
          <Label className="text-xs mb-1 block">Name</Label>
          <Input {...register("unitName", { required: true })} placeholder="Each" className="h-8 text-sm" />
          {errors.unitName && <p className="text-xs text-destructive">Required</p>}
        </div>
        <div className="w-20">
          <Label className="text-xs mb-1 block">Factor</Label>
          <Input {...register("conversionFactor", { valueAsNumber: true })} type="number" step="0.0001" placeholder="1" className="h-8 text-sm" />
        </div>
        <Button type="submit" size="sm" className="h-8" disabled={createUnit.isPending}>
          <Plus className="h-3 w-3 mr-1" /> Add
        </Button>
      </form>
    </div>
  );
}

// ─── ITEMS TAB ────────────────────────────────────────────────────────────────

type ItemRow = NonNullable<ListItemsQueryResult["items"]>[number];

function ItemModal({
  open,
  onOpenChange,
  item,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  item?: ItemRow;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateItem();
  const update = useUpdateItem();
  const isEdit = !!item;

  const { register, control, handleSubmit, reset, formState: { errors } } = useForm<CreateItemBody>({
    defaultValues: {
      code: "", name: "", description: "", itemType: "stock",
      unitOfMeasure: "", barcode: "", category: "", notes: "", isActive: true,
    },
  });

  useEffect(() => {
    if (open) {
      reset({
        code: item?.code ?? "",
        name: item?.name ?? "",
        description: item?.description ?? "",
        itemType: (item?.itemType as CreateItemBody["itemType"]) ?? "stock",
        unitOfMeasure: item?.unitOfMeasure ?? "",
        barcode: item?.barcode ?? "",
        unitCost: item?.unitCost ? Number(item.unitCost) : undefined,
        salesPrice: item?.salesPrice ? Number(item.salesPrice) : undefined,
        category: item?.category ?? "",
        notes: item?.notes ?? "",
        isActive: item?.isActive ?? true,
      });
    }
  }, [open, item, reset]);

  const onSubmit = handleSubmit(async (data) => {
    try {
      if (isEdit && item?.id) {
        await update.mutateAsync({ id: item.id, data });
        toast({ title: "Item updated" });
      } else {
        await create.mutateAsync({ data });
        toast({ title: "Item created" });
      }
      onSuccess();
      onOpenChange(false);
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  });

  const isPending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Item" : "New Item"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Code" required>
              <Input {...register("code", { required: true })} placeholder="ITEM-001" />
              {errors.code && <p className="text-xs text-destructive">Required</p>}
            </FormField>
            <FormField label="Item Type">
              <Controller control={control} name="itemType" render={({ field }) => (
                <Select value={field.value ?? "stock"} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stock">Stock</SelectItem>
                    <SelectItem value="service">Service</SelectItem>
                    <SelectItem value="charge">Charge</SelectItem>
                  </SelectContent>
                </Select>
              )} />
            </FormField>
          </div>
          <FormField label="Name" required>
            <Input {...register("name", { required: true })} placeholder="Item name" />
            {errors.name && <p className="text-xs text-destructive">Required</p>}
          </FormField>
          <FormField label="Description">
            <Textarea {...register("description")} rows={2} />
          </FormField>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Unit of Measure">
              <Input {...register("unitOfMeasure")} placeholder="EA, KG, BOX…" />
            </FormField>
            <FormField label="Barcode">
              <Input {...register("barcode")} placeholder="EAN / SKU" />
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Unit Cost">
              <Input {...register("unitCost", { valueAsNumber: true })} type="number" step="0.0001" placeholder="0.00" />
            </FormField>
            <FormField label="Sales Price">
              <Input {...register("salesPrice", { valueAsNumber: true })} type="number" step="0.0001" placeholder="0.00" />
            </FormField>
          </div>
          <FormField label="Category">
            <Input {...register("category")} />
          </FormField>
          <FormField label="Notes">
            <Textarea {...register("notes")} rows={2} />
          </FormField>
          <div className="flex items-center gap-2">
            <Controller control={control} name="isActive" render={({ field }) => (
              <Switch checked={field.value ?? true} onCheckedChange={field.onChange} id="item-active" />
            )} />
            <Label htmlFor="item-active">Active</Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving…" : isEdit ? "Save Changes" : "Create Item"}
            </Button>
          </DialogFooter>
        </form>
        {isEdit && item?.id && <ItemUnitsPanel itemId={item.id} />}
      </DialogContent>
    </Dialog>
  );
}

function ItemsTab({ initialId }: { initialId?: number }) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [allRows, setAllRows] = useState<ItemRow[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<ItemRow | undefined>();
  const [deleteItem, setDeleteItem] = useState<ItemRow | undefined>();
  const [auditTarget, setAuditTarget] = useState<{ id: string; name: string } | undefined>();
  const { sort, toggle } = useSortToggle({ field: "name", dir: "asc" });
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); setAllRows([]); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setPage(1); setAllRows([]); }, [sort.field, sort.dir]);

  const params = { q: debouncedSearch || undefined, page, limit: 25, sort: sort.field, dir: sort.dir };
  const { data, isLoading } = useListItems(params);

  useEffect(() => {
    if (!data?.items) return;
    if (page === 1) {
      setAllRows(data.items);
    } else {
      setAllRows((prev) => {
        const existingIds = new Set(prev.map((r) => r.id));
        const newRows = data.items!.filter((r) => !existingIds.has(r.id));
        return [...prev, ...newRows];
      });
    }
    setHasMore(data.hasMore ?? false);
    setIsLoadingMore(false);
  }, [data, page]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isLoadingMore) {
          setIsLoadingMore(true);
          setPage((p) => p + 1);
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore]);

  useEffect(() => {
    if (initialId && allRows.length > 0) {
      const found = allRows.find((r) => r.id === initialId);
      if (found) { setEditItem(found); setModalOpen(true); }
    }
  }, [initialId, allRows]);

  const deleteM = useDeleteItem();

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
    setPage(1);
    setAllRows([]);
  }, [queryClient]);

  const handleDelete = async () => {
    if (!deleteItem?.id) return;
    try {
      await deleteM.mutateAsync({ id: deleteItem.id });
      toast({ title: "Item deleted" });
      setDeleteItem(undefined);
      refresh();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  };

  const openCreate = () => { setEditItem(undefined); setModalOpen(true); };
  const openEdit = (row: ItemRow) => { setEditItem(row); setModalOpen(true); };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search items…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-2 ml-auto">
          <Button variant="outline" size="sm" onClick={() => exportCSV(allRows as Record<string, unknown>[], "items.csv")} disabled={!allRows.length}>
            <Download className="h-4 w-4 mr-1" /> CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportExcel(allRows as Record<string, unknown>[], "items.xlsx")} disabled={!allRows.length}>
            <Download className="h-4 w-4 mr-1" /> Excel
          </Button>
          <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> New Item</Button>
        </div>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead><SortHeader label="Code" field="code" sort={sort} onSort={toggle} /></TableHead>
              <TableHead><SortHeader label="Name" field="name" sort={sort} onSort={toggle} /></TableHead>
              <TableHead>Type</TableHead>
              <TableHead><SortHeader label="Category" field="category" sort={sort} onSort={toggle} /></TableHead>
              <TableHead>UoM</TableHead>
              <TableHead className="text-right"><SortHeader label="Cost" field="unitCost" sort={sort} onSort={toggle} /></TableHead>
              <TableHead className="text-right"><SortHeader label="Price" field="salesPrice" sort={sort} onSort={toggle} /></TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && page === 1 ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>{Array.from({ length: 9 }).map((_, j) => <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>)}</TableRow>
              ))
            ) : allRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                  No items found. Create your first item to get started.
                </TableCell>
              </TableRow>
            ) : allRows.map((row) => (
              <TableRow key={row.id} className="hover:bg-muted/50">
                <TableCell className="font-mono text-sm font-medium">{row.code}</TableCell>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell><Badge variant="outline" className="capitalize">{row.itemType}</Badge></TableCell>
                <TableCell className="text-muted-foreground">{row.category ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.unitOfMeasure ?? "—"}</TableCell>
                <TableCell className="text-right font-mono">{fmtCurrency(row.unitCost)}</TableCell>
                <TableCell className="text-right font-mono">{fmtCurrency(row.salesPrice)}</TableCell>
                <TableCell><ActiveBadge active={row.isActive} /></TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(row)}><Pencil className="h-4 w-4 mr-2" /> Edit</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setAuditTarget({ id: String(row.id), name: row.name ?? row.code ?? "" })}>
                        <History className="h-4 w-4 mr-2" /> View History
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive" onClick={() => setDeleteItem(row)}>
                        <Trash2 className="h-4 w-4 mr-2" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {isLoadingMore && (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        )}
        <div ref={sentinelRef} className="h-1" />
      </Card>

      <ItemModal open={modalOpen} onOpenChange={setModalOpen} item={editItem} onSuccess={refresh} />
      <DeleteConfirm open={!!deleteItem} onOpenChange={(v) => !v && setDeleteItem(undefined)} name={deleteItem?.name ?? "item"} onConfirm={handleDelete} isPending={deleteM.isPending} />
      {auditTarget && (
        <AuditTrailDialog
          open={!!auditTarget}
          onOpenChange={(v) => !v && setAuditTarget(undefined)}
          entityType="item"
          entityId={auditTarget.id}
          entityName={auditTarget.name}
        />
      )}
    </div>
  );
}

// ─── SUPPLIERS TAB ────────────────────────────────────────────────────────────

type SupplierRow = NonNullable<ListSuppliersQueryResult["suppliers"]>[number];

function SupplierModal({
  open,
  onOpenChange,
  supplier,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  supplier?: SupplierRow;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateSupplier();
  const update = useUpdateSupplier();
  const isEdit = !!supplier;

  const { register, control, handleSubmit, reset, formState: { errors } } = useForm<CreateSupplierBody>({
    defaultValues: { code: "", name: "", currency: "AUD", isActive: true },
  });

  useEffect(() => {
    if (open) {
      reset({
        code: supplier?.code ?? "",
        name: supplier?.name ?? "",
        legalName: supplier?.legalName ?? "",
        taxId: supplier?.taxId ?? "",
        email: supplier?.email ?? "",
        phone: supplier?.phone ?? "",
        website: supplier?.website ?? "",
        addressLine1: supplier?.addressLine1 ?? "",
        city: supplier?.city ?? "",
        state: supplier?.state ?? "",
        postalCode: supplier?.postalCode ?? "",
        country: supplier?.country ?? "",
        paymentTerms: supplier?.paymentTerms ?? "",
        currency: supplier?.currency ?? "AUD",
        creditLimit: supplier?.creditLimit ? Number(supplier.creditLimit) : undefined,
        isActive: supplier?.isActive ?? true,
        notes: supplier?.notes ?? "",
        onTimeDeliveryPct: supplier?.onTimeDeliveryPct ? Number(supplier.onTimeDeliveryPct) : undefined,
        fillRatePct: supplier?.fillRatePct ? Number(supplier.fillRatePct) : undefined,
      });
    }
  }, [open, supplier, reset]);

  const onSubmit = handleSubmit(async (data) => {
    try {
      if (isEdit && supplier?.id) {
        await update.mutateAsync({ id: supplier.id, data });
        toast({ title: "Supplier updated" });
      } else {
        await create.mutateAsync({ data });
        toast({ title: "Supplier created" });
      }
      onSuccess();
      onOpenChange(false);
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  });

  const isPending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{isEdit ? "Edit Supplier" : "New Supplier"}</DialogTitle></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Code" required>
              <Input {...register("code", { required: true })} placeholder="SUP-001" />
              {errors.code && <p className="text-xs text-destructive">Required</p>}
            </FormField>
            <FormField label="Currency"><Input {...register("currency")} placeholder="AUD" /></FormField>
          </div>
          <FormField label="Name" required>
            <Input {...register("name", { required: true })} placeholder="Supplier name" />
            {errors.name && <p className="text-xs text-destructive">Required</p>}
          </FormField>
          <FormField label="Legal Name"><Input {...register("legalName")} /></FormField>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Tax ID / ABN"><Input {...register("taxId")} /></FormField>
            <FormField label="Payment Terms"><Input {...register("paymentTerms")} placeholder="Net 30" /></FormField>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Email"><Input {...register("email")} type="email" /></FormField>
            <FormField label="Phone"><Input {...register("phone")} /></FormField>
          </div>
          <FormField label="Website"><Input {...register("website")} /></FormField>
          <FormField label="Address"><Input {...register("addressLine1")} placeholder="Street address" /></FormField>
          <div className="grid grid-cols-3 gap-4">
            <FormField label="City"><Input {...register("city")} /></FormField>
            <FormField label="State"><Input {...register("state")} /></FormField>
            <FormField label="Postcode"><Input {...register("postalCode")} /></FormField>
          </div>
          <FormField label="Country"><Input {...register("country")} placeholder="Australia" /></FormField>
          <FormField label="Credit Limit">
            <Input {...register("creditLimit", { valueAsNumber: true })} type="number" step="0.01" placeholder="0.00" />
          </FormField>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="On-Time Delivery %">
              <Input {...register("onTimeDeliveryPct", { valueAsNumber: true })} type="number" min={0} max={100} step="0.1" placeholder="0–100" />
            </FormField>
            <FormField label="Fill Rate %">
              <Input {...register("fillRatePct", { valueAsNumber: true })} type="number" min={0} max={100} step="0.1" placeholder="0–100" />
            </FormField>
          </div>
          <FormField label="Notes"><Textarea {...register("notes")} rows={2} /></FormField>
          <div className="flex items-center gap-2">
            <Controller control={control} name="isActive" render={({ field }) => (
              <Switch checked={field.value ?? true} onCheckedChange={field.onChange} id="sup-active" />
            )} />
            <Label htmlFor="sup-active">Active</Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
            <Button type="submit" disabled={isPending}>{isPending ? "Saving…" : isEdit ? "Save Changes" : "Create Supplier"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SuppliersTab({ initialId }: { initialId?: number }) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [allRows, setAllRows] = useState<SupplierRow[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editRow, setEditRow] = useState<SupplierRow | undefined>();
  const [deleteRow, setDeleteRow] = useState<SupplierRow | undefined>();
  const [auditTarget, setAuditTarget] = useState<{ id: string; name: string } | undefined>();
  const { sort, toggle } = useSortToggle({ field: "name", dir: "asc" });
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); setAllRows([]); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setPage(1); setAllRows([]); }, [sort.field, sort.dir]);

  const params = { q: debouncedSearch || undefined, page, limit: 25, sort: sort.field, dir: sort.dir as "asc" | "desc" };
  const { data, isLoading } = useListSuppliers(params);

  useEffect(() => {
    if (!data?.suppliers) return;
    if (page === 1) setAllRows(data.suppliers);
    else setAllRows((prev) => {
      const ids = new Set(prev.map((r) => r.id));
      return [...prev, ...data.suppliers!.filter((r) => !ids.has(r.id))];
    });
    setHasMore(data.hasMore ?? false);
    setIsLoadingMore(false);
  }, [data, page]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const obs = new IntersectionObserver(
      (e) => { if (e[0]?.isIntersecting && !isLoadingMore) { setIsLoadingMore(true); setPage((p) => p + 1); } },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, isLoadingMore]);

  useEffect(() => {
    if (initialId && allRows.length > 0) {
      const found = allRows.find((r) => r.id === initialId);
      if (found) { setEditRow(found); setModalOpen(true); }
    }
  }, [initialId, allRows]);

  const deleteM = useDeleteSupplier();
  const refresh = useCallback(() => { queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() }); setPage(1); setAllRows([]); }, [queryClient]);
  const handleDelete = async () => {
    if (!deleteRow?.id) return;
    try { await deleteM.mutateAsync({ id: deleteRow.id }); toast({ title: "Supplier deleted" }); setDeleteRow(undefined); refresh(); }
    catch (e: unknown) { toast({ title: "Error", description: (e as Error).message, variant: "destructive" }); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search suppliers…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-2 ml-auto">
          <Button variant="outline" size="sm" onClick={() => exportCSV(allRows as Record<string, unknown>[], "suppliers.csv")} disabled={!allRows.length}>
            <Download className="h-4 w-4 mr-1" /> CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportExcel(allRows as Record<string, unknown>[], "suppliers.xlsx")} disabled={!allRows.length}>
            <Download className="h-4 w-4 mr-1" /> Excel
          </Button>
          <Button onClick={() => { setEditRow(undefined); setModalOpen(true); }}><Plus className="h-4 w-4 mr-1" /> New Supplier</Button>
        </div>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead><SortHeader label="Code" field="code" sort={sort} onSort={toggle} /></TableHead>
              <TableHead><SortHeader label="Name" field="name" sort={sort} onSort={toggle} /></TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead><SortHeader label="City" field="city" sort={sort} onSort={toggle} /></TableHead>
              <TableHead>Country</TableHead>
              <TableHead>Terms</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && page === 1 ? (
              Array.from({ length: 5 }).map((_, i) => <TableRow key={i}>{Array.from({ length: 9 }).map((_, j) => <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>)}</TableRow>)
            ) : allRows.length === 0 ? (
              <TableRow><TableCell colSpan={9} className="text-center py-12 text-muted-foreground">No suppliers found.</TableCell></TableRow>
            ) : allRows.map((row) => (
              <TableRow key={row.id} className="hover:bg-muted/50">
                <TableCell className="font-mono text-sm font-medium">{row.code}</TableCell>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell className="text-muted-foreground">{row.email ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.phone ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.city ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.country ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.paymentTerms ?? "—"}</TableCell>
                <TableCell><ActiveBadge active={row.isActive} /></TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => { setEditRow(row); setModalOpen(true); }}><Pencil className="h-4 w-4 mr-2" /> Edit</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setAuditTarget({ id: String(row.id), name: row.name ?? row.code ?? "" })}>
                        <History className="h-4 w-4 mr-2" /> View History
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive" onClick={() => setDeleteRow(row)}><Trash2 className="h-4 w-4 mr-2" /> Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {isLoadingMore && <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
        <div ref={sentinelRef} className="h-1" />
      </Card>
      <SupplierModal open={modalOpen} onOpenChange={setModalOpen} supplier={editRow} onSuccess={refresh} />
      <DeleteConfirm open={!!deleteRow} onOpenChange={(v) => !v && setDeleteRow(undefined)} name={deleteRow?.name ?? "supplier"} onConfirm={handleDelete} isPending={deleteM.isPending} />
      {auditTarget && <AuditTrailDialog open={!!auditTarget} onOpenChange={(v) => !v && setAuditTarget(undefined)} entityType="supplier" entityId={auditTarget.id} entityName={auditTarget.name} />}
    </div>
  );
}

// ─── CUSTOMERS TAB ────────────────────────────────────────────────────────────

type CustomerRow = NonNullable<ListCustomersQueryResult["customers"]>[number];

function CustomerModal({ open, onOpenChange, customer, onSuccess }: {
  open: boolean; onOpenChange: (v: boolean) => void; customer?: CustomerRow; onSuccess: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateCustomer();
  const update = useUpdateCustomer();
  const isEdit = !!customer;
  const { register, control, handleSubmit, reset, formState: { errors } } = useForm<CreateCustomerBody>({
    defaultValues: { code: "", name: "", currency: "AUD", isActive: true },
  });
  useEffect(() => {
    if (open) reset({
      code: customer?.code ?? "", name: customer?.name ?? "",
      legalName: customer?.legalName ?? "", taxId: customer?.taxId ?? "",
      email: customer?.email ?? "", phone: customer?.phone ?? "",
      billingAddressLine1: customer?.billingAddressLine1 ?? "", billingCity: customer?.billingCity ?? "",
      billingState: customer?.billingState ?? "", billingPostalCode: customer?.billingPostalCode ?? "",
      billingCountry: customer?.billingCountry ?? "",
      creditLimit: customer?.creditLimit ? Number(customer.creditLimit) : undefined,
      paymentTerms: customer?.paymentTerms ?? "", currency: customer?.currency ?? "AUD",
      isActive: customer?.isActive ?? true, notes: customer?.notes ?? "",
    });
  }, [open, customer, reset]);
  const onSubmit = handleSubmit(async (data) => {
    try {
      if (isEdit && customer?.id) { await update.mutateAsync({ id: customer.id, data }); toast({ title: "Customer updated" }); }
      else { await create.mutateAsync({ data }); toast({ title: "Customer created" }); }
      onSuccess(); onOpenChange(false);
    } catch (e: unknown) { toast({ title: "Error", description: (e as Error).message, variant: "destructive" }); }
  });
  const isPending = create.isPending || update.isPending;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{isEdit ? "Edit Customer" : "New Customer"}</DialogTitle></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Code" required>
              <Input {...register("code", { required: true })} placeholder="CUST-001" />
              {errors.code && <p className="text-xs text-destructive">Required</p>}
            </FormField>
            <FormField label="Currency"><Input {...register("currency")} placeholder="AUD" /></FormField>
          </div>
          <FormField label="Name" required>
            <Input {...register("name", { required: true })} />
            {errors.name && <p className="text-xs text-destructive">Required</p>}
          </FormField>
          <FormField label="Legal Name"><Input {...register("legalName")} /></FormField>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Tax ID / ABN"><Input {...register("taxId")} /></FormField>
            <FormField label="Payment Terms"><Input {...register("paymentTerms")} placeholder="Net 30" /></FormField>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Email"><Input {...register("email")} type="email" /></FormField>
            <FormField label="Phone"><Input {...register("phone")} /></FormField>
          </div>
          <FormField label="Billing Address"><Input {...register("billingAddressLine1")} placeholder="Street address" /></FormField>
          <div className="grid grid-cols-3 gap-4">
            <FormField label="City"><Input {...register("billingCity")} /></FormField>
            <FormField label="State"><Input {...register("billingState")} /></FormField>
            <FormField label="Postcode"><Input {...register("billingPostalCode")} /></FormField>
          </div>
          <FormField label="Country"><Input {...register("billingCountry")} placeholder="Australia" /></FormField>
          <FormField label="Credit Limit">
            <Input {...register("creditLimit", { valueAsNumber: true })} type="number" step="0.01" placeholder="0.00" />
          </FormField>
          <FormField label="Notes"><Textarea {...register("notes")} rows={2} /></FormField>
          <div className="flex items-center gap-2">
            <Controller control={control} name="isActive" render={({ field }) => (
              <Switch checked={field.value ?? true} onCheckedChange={field.onChange} id="cust-active" />
            )} />
            <Label htmlFor="cust-active">Active</Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
            <Button type="submit" disabled={isPending}>{isPending ? "Saving…" : isEdit ? "Save Changes" : "Create Customer"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CustomersTab({ initialId }: { initialId?: number }) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [allRows, setAllRows] = useState<CustomerRow[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editRow, setEditRow] = useState<CustomerRow | undefined>();
  const [deleteRow, setDeleteRow] = useState<CustomerRow | undefined>();
  const [auditTarget, setAuditTarget] = useState<{ id: string; name: string } | undefined>();
  const { sort, toggle } = useSortToggle({ field: "name", dir: "asc" });
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); setAllRows([]); }, 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => { setPage(1); setAllRows([]); }, [sort.field, sort.dir]);

  const { data, isLoading } = useListCustomers({ q: debouncedSearch || undefined, page, limit: 25, sort: sort.field, dir: sort.dir as "asc" | "desc" });

  useEffect(() => {
    if (!data?.customers) return;
    if (page === 1) setAllRows(data.customers);
    else setAllRows((prev) => { const ids = new Set(prev.map((r) => r.id)); return [...prev, ...data.customers!.filter((r) => !ids.has(r.id))]; });
    setHasMore(data.hasMore ?? false); setIsLoadingMore(false);
  }, [data, page]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const obs = new IntersectionObserver((e) => { if (e[0]?.isIntersecting && !isLoadingMore) { setIsLoadingMore(true); setPage((p) => p + 1); } }, { rootMargin: "200px" });
    obs.observe(el); return () => obs.disconnect();
  }, [hasMore, isLoadingMore]);

  useEffect(() => {
    if (initialId && allRows.length > 0) { const found = allRows.find((r) => r.id === initialId); if (found) { setEditRow(found); setModalOpen(true); } }
  }, [initialId, allRows]);

  const deleteM = useDeleteCustomer();
  const refresh = useCallback(() => { queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() }); setPage(1); setAllRows([]); }, [queryClient]);
  const handleDelete = async () => {
    if (!deleteRow?.id) return;
    try { await deleteM.mutateAsync({ id: deleteRow.id }); toast({ title: "Customer deleted" }); setDeleteRow(undefined); refresh(); }
    catch (e: unknown) { toast({ title: "Error", description: (e as Error).message, variant: "destructive" }); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search customers…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-2 ml-auto">
          <Button variant="outline" size="sm" onClick={() => exportCSV(allRows as Record<string, unknown>[], "customers.csv")} disabled={!allRows.length}>
            <Download className="h-4 w-4 mr-1" /> CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportExcel(allRows as Record<string, unknown>[], "customers.xlsx")} disabled={!allRows.length}>
            <Download className="h-4 w-4 mr-1" /> Excel
          </Button>
          <Button onClick={() => { setEditRow(undefined); setModalOpen(true); }}><Plus className="h-4 w-4 mr-1" /> New Customer</Button>
        </div>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead><SortHeader label="Code" field="code" sort={sort} onSort={toggle} /></TableHead>
              <TableHead><SortHeader label="Name" field="name" sort={sort} onSort={toggle} /></TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead><SortHeader label="Billing City" field="billingCity" sort={sort} onSort={toggle} /></TableHead>
              <TableHead>Terms</TableHead>
              <TableHead className="text-right"><SortHeader label="Credit Limit" field="creditLimit" sort={sort} onSort={toggle} /></TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && page === 1 ? (
              Array.from({ length: 5 }).map((_, i) => <TableRow key={i}>{Array.from({ length: 9 }).map((_, j) => <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>)}</TableRow>)
            ) : allRows.length === 0 ? (
              <TableRow><TableCell colSpan={9} className="text-center py-12 text-muted-foreground">No customers found.</TableCell></TableRow>
            ) : allRows.map((row) => (
              <TableRow key={row.id} className="hover:bg-muted/50">
                <TableCell className="font-mono text-sm font-medium">{row.code}</TableCell>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell className="text-muted-foreground">{row.email ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.phone ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.billingCity ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.paymentTerms ?? "—"}</TableCell>
                <TableCell className="text-right font-mono">{fmtCurrency(row.creditLimit)}</TableCell>
                <TableCell><ActiveBadge active={row.isActive} /></TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => { setEditRow(row); setModalOpen(true); }}><Pencil className="h-4 w-4 mr-2" /> Edit</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setAuditTarget({ id: String(row.id), name: row.name ?? "" })}>
                        <History className="h-4 w-4 mr-2" /> View History
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive" onClick={() => setDeleteRow(row)}><Trash2 className="h-4 w-4 mr-2" /> Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {isLoadingMore && <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
        <div ref={sentinelRef} className="h-1" />
      </Card>
      <CustomerModal open={modalOpen} onOpenChange={setModalOpen} customer={editRow} onSuccess={refresh} />
      <DeleteConfirm open={!!deleteRow} onOpenChange={(v) => !v && setDeleteRow(undefined)} name={deleteRow?.name ?? "customer"} onConfirm={handleDelete} isPending={deleteM.isPending} />
      {auditTarget && <AuditTrailDialog open={!!auditTarget} onOpenChange={(v) => !v && setAuditTarget(undefined)} entityType="customer" entityId={auditTarget.id} entityName={auditTarget.name} />}
    </div>
  );
}

// ─── WAREHOUSES TAB ───────────────────────────────────────────────────────────

type WarehouseRow = NonNullable<ListWarehousesQueryResult["warehouses"]>[number];

function WarehouseModal({ open, onOpenChange, warehouse, onSuccess }: {
  open: boolean; onOpenChange: (v: boolean) => void; warehouse?: WarehouseRow; onSuccess: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateWarehouse();
  const update = useUpdateWarehouse();
  const isEdit = !!warehouse;
  const { register, control, handleSubmit, reset, formState: { errors } } = useForm<CreateWarehouseBody>({
    defaultValues: { name: "", code: "", isDefault: "false", isActive: true },
  });
  useEffect(() => {
    if (open) reset({
      name: warehouse?.name ?? "", code: warehouse?.code ?? "",
      addressLine1: warehouse?.addressLine1 ?? "", city: warehouse?.city ?? "",
      state: warehouse?.state ?? "", country: warehouse?.country ?? "",
      isDefault: (warehouse?.isDefault as CreateWarehouseBody["isDefault"]) ?? "false",
      isActive: warehouse?.isActive ?? true, notes: warehouse?.notes ?? "",
    });
  }, [open, warehouse, reset]);
  const onSubmit = handleSubmit(async (data) => {
    try {
      if (isEdit && warehouse?.id) { await update.mutateAsync({ id: warehouse.id, data }); toast({ title: "Warehouse updated" }); }
      else { await create.mutateAsync({ data }); toast({ title: "Warehouse created" }); }
      onSuccess(); onOpenChange(false);
    } catch (e: unknown) { toast({ title: "Error", description: (e as Error).message, variant: "destructive" }); }
  });
  const isPending = create.isPending || update.isPending;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{isEdit ? "Edit Warehouse" : "New Warehouse"}</DialogTitle></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <FormField label="Name" required>
            <Input {...register("name", { required: true })} placeholder="Main Warehouse" />
            {errors.name && <p className="text-xs text-destructive">Required</p>}
          </FormField>
          <FormField label="Code"><Input {...register("code")} placeholder="WH-MAIN" /></FormField>
          <FormField label="Address"><Input {...register("addressLine1")} placeholder="Street address" /></FormField>
          <div className="grid grid-cols-3 gap-4">
            <FormField label="City"><Input {...register("city")} /></FormField>
            <FormField label="State"><Input {...register("state")} /></FormField>
            <FormField label="Country"><Input {...register("country")} /></FormField>
          </div>
          <FormField label="Notes"><Textarea {...register("notes")} rows={2} /></FormField>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Controller control={control} name="isDefault" render={({ field }) => (
                <Switch checked={field.value === "true"} onCheckedChange={(v) => field.onChange(v ? "true" : "false")} id="wh-default" />
              )} />
              <Label htmlFor="wh-default">Default Warehouse</Label>
            </div>
            <div className="flex items-center gap-2">
              <Controller control={control} name="isActive" render={({ field }) => (
                <Switch checked={field.value ?? true} onCheckedChange={field.onChange} id="wh-active" />
              )} />
              <Label htmlFor="wh-active">Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
            <Button type="submit" disabled={isPending}>{isPending ? "Saving…" : isEdit ? "Save Changes" : "Create Warehouse"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WarehousesTab({ initialId }: { initialId?: number }) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [allRows, setAllRows] = useState<WarehouseRow[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editRow, setEditRow] = useState<WarehouseRow | undefined>();
  const [deleteRow, setDeleteRow] = useState<WarehouseRow | undefined>();
  const [auditTarget, setAuditTarget] = useState<{ id: string; name: string } | undefined>();
  const { sort, toggle } = useSortToggle({ field: "name", dir: "asc" });
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); setAllRows([]); }, 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => { setPage(1); setAllRows([]); }, [sort.field, sort.dir]);

  const { data, isLoading } = useListWarehouses({ q: debouncedSearch || undefined, page, limit: 25, sort: sort.field, dir: sort.dir as "asc" | "desc" });

  useEffect(() => {
    if (!data?.warehouses) return;
    if (page === 1) setAllRows(data.warehouses);
    else setAllRows((prev) => { const ids = new Set(prev.map((r) => r.id)); return [...prev, ...data.warehouses!.filter((r) => !ids.has(r.id))]; });
    setHasMore(data.hasMore ?? false); setIsLoadingMore(false);
  }, [data, page]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const obs = new IntersectionObserver((e) => { if (e[0]?.isIntersecting && !isLoadingMore) { setIsLoadingMore(true); setPage((p) => p + 1); } }, { rootMargin: "200px" });
    obs.observe(el); return () => obs.disconnect();
  }, [hasMore, isLoadingMore]);

  useEffect(() => {
    if (initialId && allRows.length > 0) { const found = allRows.find((r) => r.id === initialId); if (found) { setEditRow(found); setModalOpen(true); } }
  }, [initialId, allRows]);

  const deleteM = useDeleteWarehouse();
  const refresh = useCallback(() => { queryClient.invalidateQueries({ queryKey: getListWarehousesQueryKey() }); setPage(1); setAllRows([]); }, [queryClient]);
  const handleDelete = async () => {
    if (!deleteRow?.id) return;
    try { await deleteM.mutateAsync({ id: deleteRow.id }); toast({ title: "Warehouse deleted" }); setDeleteRow(undefined); refresh(); }
    catch (e: unknown) { toast({ title: "Error", description: (e as Error).message, variant: "destructive" }); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search warehouses…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-2 ml-auto">
          <Button variant="outline" size="sm" onClick={() => exportCSV(allRows as Record<string, unknown>[], "warehouses.csv")} disabled={!allRows.length}>
            <Download className="h-4 w-4 mr-1" /> CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportExcel(allRows as Record<string, unknown>[], "warehouses.xlsx")} disabled={!allRows.length}>
            <Download className="h-4 w-4 mr-1" /> Excel
          </Button>
          <Button onClick={() => { setEditRow(undefined); setModalOpen(true); }}><Plus className="h-4 w-4 mr-1" /> New Warehouse</Button>
        </div>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead><SortHeader label="Name" field="name" sort={sort} onSort={toggle} /></TableHead>
              <TableHead>Code</TableHead>
              <TableHead><SortHeader label="City" field="city" sort={sort} onSort={toggle} /></TableHead>
              <TableHead>State</TableHead>
              <TableHead>Country</TableHead>
              <TableHead>Default</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && page === 1 ? (
              Array.from({ length: 4 }).map((_, i) => <TableRow key={i}>{Array.from({ length: 8 }).map((_, j) => <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>)}</TableRow>)
            ) : allRows.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="text-center py-12 text-muted-foreground">No warehouses found.</TableCell></TableRow>
            ) : allRows.map((row) => (
              <TableRow key={row.id} className="hover:bg-muted/50">
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell className="font-mono text-sm">{row.code ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.city ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.state ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.country ?? "—"}</TableCell>
                <TableCell>
                  {row.isDefault === "true" ? <Badge variant="default" className="bg-blue-100 text-blue-800 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400">Default</Badge> : "—"}
                </TableCell>
                <TableCell><ActiveBadge active={row.isActive} /></TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => { setEditRow(row); setModalOpen(true); }}><Pencil className="h-4 w-4 mr-2" /> Edit</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setAuditTarget({ id: String(row.id), name: row.name ?? "" })}>
                        <History className="h-4 w-4 mr-2" /> View History
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive" onClick={() => setDeleteRow(row)}><Trash2 className="h-4 w-4 mr-2" /> Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {isLoadingMore && <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
        <div ref={sentinelRef} className="h-1" />
      </Card>
      <WarehouseModal open={modalOpen} onOpenChange={setModalOpen} warehouse={editRow} onSuccess={refresh} />
      <DeleteConfirm open={!!deleteRow} onOpenChange={(v) => !v && setDeleteRow(undefined)} name={deleteRow?.name ?? "warehouse"} onConfirm={handleDelete} isPending={deleteM.isPending} />
      {auditTarget && <AuditTrailDialog open={!!auditTarget} onOpenChange={(v) => !v && setAuditTarget(undefined)} entityType="warehouse" entityId={auditTarget.id} entityName={auditTarget.name} />}
    </div>
  );
}

// ─── GL ACCOUNTS TAB ─────────────────────────────────────────────────────────

type GlAccountRow = NonNullable<ListGlAccountsQueryResult["accounts"]>[number];
const GL_ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
const GL_TEMPLATES: { value: GlTemplateImportBodyTemplate; label: string }[] = [
  { value: "standard", label: "Standard" },
  { value: "manufacturing", label: "Manufacturing" },
];
const TYPE_COLORS: Record<string, string> = {
  asset: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  liability: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  equity: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
  revenue: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  expense: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
};

function GlAccountModal({ open, onOpenChange, account, allAccounts, onSuccess }: {
  open: boolean; onOpenChange: (v: boolean) => void; account?: GlAccountRow; allAccounts: GlAccountRow[]; onSuccess: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateGlAccount();
  const update = useUpdateGlAccount();
  const isEdit = !!account;
  const { register, control, handleSubmit, reset, formState: { errors } } = useForm<CreateGlAccountBody>({
    defaultValues: { code: "", name: "", accountType: "asset", isPosting: true, isActive: true },
  });
  useEffect(() => {
    if (open) reset({
      code: account?.code ?? "", name: account?.name ?? "",
      accountType: (account?.accountType as CreateGlAccountBody["accountType"]) ?? "asset",
      description: account?.description ?? "", taxCode: account?.taxCode ?? "",
      parentId: account?.parentId ?? undefined, isPosting: account?.isPosting ?? true, isActive: account?.isActive ?? true,
    });
  }, [open, account, reset]);
  const onSubmit = handleSubmit(async (data) => {
    try {
      if (isEdit && account?.id) { await update.mutateAsync({ id: account.id, data }); toast({ title: "GL account updated" }); }
      else { await create.mutateAsync({ data }); toast({ title: "GL account created" }); }
      onSuccess(); onOpenChange(false);
    } catch (e: unknown) { toast({ title: "Error", description: (e as Error).message, variant: "destructive" }); }
  });
  const isPending = create.isPending || update.isPending;
  const parentOptions = allAccounts.filter((a) => a.id !== account?.id);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{isEdit ? "Edit GL Account" : "New GL Account"}</DialogTitle></DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Code" required>
              <Input {...register("code", { required: true })} placeholder="1000" />
              {errors.code && <p className="text-xs text-destructive">Required</p>}
            </FormField>
            <FormField label="Account Type" required>
              <Controller control={control} name="accountType" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {GL_ACCOUNT_TYPES.map((t) => <SelectItem key={t} value={t} className="capitalize">{t.charAt(0).toUpperCase() + t.slice(1)}</SelectItem>)}
                  </SelectContent>
                </Select>
              )} />
            </FormField>
          </div>
          <FormField label="Name" required>
            <Input {...register("name", { required: true })} placeholder="Cash and Cash Equivalents" />
            {errors.name && <p className="text-xs text-destructive">Required</p>}
          </FormField>
          <FormField label="Parent Account">
            <Controller control={control} name="parentId" render={({ field }) => (
              <Select value={field.value?.toString() ?? "none"} onValueChange={(v) => field.onChange(v === "none" ? undefined : Number(v))}>
                <SelectTrigger><SelectValue placeholder="No parent" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No parent</SelectItem>
                  {parentOptions.map((a) => <SelectItem key={a.id} value={a.id!.toString()}>{a.code} — {a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )} />
          </FormField>
          <FormField label="Description"><Textarea {...register("description")} rows={2} /></FormField>
          <FormField label="Tax Code"><Input {...register("taxCode")} placeholder="e.g. GST, CAP" /></FormField>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Controller control={control} name="isPosting" render={({ field }) => (
                <Switch checked={field.value ?? true} onCheckedChange={field.onChange} id="gl-posting" />
              )} />
              <Label htmlFor="gl-posting">Posting Account</Label>
            </div>
            <div className="flex items-center gap-2">
              <Controller control={control} name="isActive" render={({ field }) => (
                <Switch checked={field.value ?? true} onCheckedChange={field.onChange} id="gl-active" />
              )} />
              <Label htmlFor="gl-active">Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
            <Button type="submit" disabled={isPending}>{isPending ? "Saving…" : isEdit ? "Save Changes" : "Create Account"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportTemplateDialog({ open, onOpenChange, onSuccess }: {
  open: boolean; onOpenChange: (v: boolean) => void; onSuccess: () => void;
}) {
  const { toast } = useToast();
  const importTemplate = useImportGlAccountTemplate();
  const [template, setTemplate] = useState<GlTemplateImportBodyTemplate>("standard");
  const handleImport = async () => {
    try {
      await importTemplate.mutateAsync({ data: { template } });
      toast({ title: "Chart of accounts imported", description: `Imported ${template} template.` });
      onSuccess(); onOpenChange(false);
    } catch (e: unknown) { toast({ title: "Import failed", description: (e as Error).message, variant: "destructive" }); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Import Chart of Accounts</DialogTitle>
          <DialogDescription>Import a pre-built chart of accounts template. Existing accounts with matching codes will be skipped.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <FormField label="Template">
            <Select value={template} onValueChange={(v) => setTemplate(v as GlTemplateImportBodyTemplate)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{GL_TEMPLATES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
            </Select>
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={importTemplate.isPending}>Cancel</Button>
          <Button onClick={handleImport} disabled={importTemplate.isPending}>
            <Download className="h-4 w-4 mr-1" />
            {importTemplate.isPending ? "Importing…" : "Import Template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GlAccountsTab({ initialId }: { initialId?: number }) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [allRows, setAllRows] = useState<GlAccountRow[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editRow, setEditRow] = useState<GlAccountRow | undefined>();
  const [deleteRow, setDeleteRow] = useState<GlAccountRow | undefined>();
  const [auditTarget, setAuditTarget] = useState<{ id: string; name: string } | undefined>();
  const { sort, toggle } = useSortToggle({ field: "code", dir: "asc" });
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); setAllRows([]); }, 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => { setPage(1); setAllRows([]); }, [sort.field, sort.dir, typeFilter]);

  const params = { q: debouncedSearch || undefined, accountType: typeFilter !== "all" ? typeFilter : undefined, page, limit: 50, sort: sort.field, dir: sort.dir };
  const { data, isLoading } = useListGlAccounts(params);
  const { data: allData } = useListGlAccounts({ limit: 500 });

  useEffect(() => {
    if (!data?.accounts) return;
    if (page === 1) setAllRows(data.accounts);
    else setAllRows((prev) => { const ids = new Set(prev.map((r) => r.id)); return [...prev, ...data.accounts!.filter((r) => !ids.has(r.id))]; });
    setHasMore(data.hasMore ?? false); setIsLoadingMore(false);
  }, [data, page]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const obs = new IntersectionObserver((e) => { if (e[0]?.isIntersecting && !isLoadingMore) { setIsLoadingMore(true); setPage((p) => p + 1); } }, { rootMargin: "200px" });
    obs.observe(el); return () => obs.disconnect();
  }, [hasMore, isLoadingMore]);

  useEffect(() => {
    if (initialId && allRows.length > 0) { const found = allRows.find((r) => r.id === initialId); if (found) { setEditRow(found); setModalOpen(true); } }
  }, [initialId, allRows]);

  const deleteM = useDeleteGlAccount();
  const refresh = useCallback(() => { queryClient.invalidateQueries({ queryKey: getListGlAccountsQueryKey() }); setPage(1); setAllRows([]); }, [queryClient]);
  const handleDelete = async () => {
    if (!deleteRow?.id) return;
    try { await deleteM.mutateAsync({ id: deleteRow.id }); toast({ title: "GL account deleted" }); setDeleteRow(undefined); refresh(); }
    catch (e: unknown) { toast({ title: "Error", description: (e as Error).message, variant: "destructive" }); }
  };

  const allAccounts = allData?.accounts ?? [];
  const accountMap = new Map(allAccounts.map((a) => [a.id, a]));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search accounts…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); setPage(1); setAllRows([]); }}>
          <SelectTrigger className="w-40"><SelectValue placeholder="All types" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {GL_ACCOUNT_TYPES.map((t) => <SelectItem key={t} value={t} className="capitalize">{t.charAt(0).toUpperCase() + t.slice(1)}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex gap-2 ml-auto">
          <Button variant="outline" size="sm" onClick={() => exportCSV(allRows as Record<string, unknown>[], "gl-accounts.csv")} disabled={!allRows.length}>
            <Download className="h-4 w-4 mr-1" /> CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportExcel(allRows as Record<string, unknown>[], "gl-accounts.xlsx")} disabled={!allRows.length}>
            <Download className="h-4 w-4 mr-1" /> Excel
          </Button>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Download className="h-4 w-4 mr-1" /> Import Template
          </Button>
          <Button onClick={() => { setEditRow(undefined); setModalOpen(true); }}><Plus className="h-4 w-4 mr-1" /> New Account</Button>
        </div>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead><SortHeader label="Code" field="code" sort={sort} onSort={toggle} /></TableHead>
              <TableHead><SortHeader label="Name" field="name" sort={sort} onSort={toggle} /></TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Parent</TableHead>
              <TableHead>Tax Code</TableHead>
              <TableHead>Posting</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && page === 1 ? (
              Array.from({ length: 6 }).map((_, i) => <TableRow key={i}>{Array.from({ length: 8 }).map((_, j) => <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>)}</TableRow>)
            ) : allRows.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="text-center py-12 text-muted-foreground">No GL accounts found. Import a template or create your first account.</TableCell></TableRow>
            ) : allRows.map((row) => {
              const parent = row.parentId ? accountMap.get(row.parentId) : null;
              return (
                <TableRow key={row.id} className="hover:bg-muted/50">
                  <TableCell className="font-mono text-sm font-medium">{row.code}</TableCell>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell>
                    <Badge variant="secondary" className={`capitalize ${TYPE_COLORS[row.accountType ?? ""] ?? ""}`}>{row.accountType}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{parent ? `${parent.code} — ${parent.name}` : "—"}</TableCell>
                  <TableCell className="text-muted-foreground">{row.taxCode ?? "—"}</TableCell>
                  <TableCell>{row.isPosting ? <Badge variant="outline" className="text-xs">Posting</Badge> : <Badge variant="secondary" className="text-xs">Header</Badge>}</TableCell>
                  <TableCell><ActiveBadge active={row.isActive} /></TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => { setEditRow(row); setModalOpen(true); }}><Pencil className="h-4 w-4 mr-2" /> Edit</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setAuditTarget({ id: String(row.id), name: row.name ?? row.code ?? "" })}>
                          <History className="h-4 w-4 mr-2" /> View History
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive" onClick={() => setDeleteRow(row)}><Trash2 className="h-4 w-4 mr-2" /> Delete</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
        {isLoadingMore && <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>}
        <div ref={sentinelRef} className="h-1" />
      </Card>
      <GlAccountModal open={modalOpen} onOpenChange={setModalOpen} account={editRow} allAccounts={allAccounts} onSuccess={refresh} />
      <ImportTemplateDialog open={importOpen} onOpenChange={setImportOpen} onSuccess={refresh} />
      <DeleteConfirm open={!!deleteRow} onOpenChange={(v) => !v && setDeleteRow(undefined)} name={deleteRow?.name ?? "GL account"} onConfirm={handleDelete} isPending={deleteM.isPending} />
      {auditTarget && <AuditTrailDialog open={!!auditTarget} onOpenChange={(v) => !v && setAuditTarget(undefined)} entityType="gl_account" entityId={auditTarget.id} entityName={auditTarget.name} />}
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────

const TABS = [
  { id: "items", label: "Items", icon: Package },
  { id: "suppliers", label: "Suppliers", icon: Truck },
  { id: "customers", label: "Customers", icon: Users },
  { id: "warehouses", label: "Warehouses", icon: Warehouse },
  { id: "gl-accounts", label: "GL Accounts", icon: BookOpen },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function MasterData() {
  const [, setLocation] = useLocation();
  const urlParams = new URLSearchParams(window.location.search);
  const rawTab = urlParams.get("tab");
  const activeTab: TabId = (TABS.find((t) => t.id === rawTab)?.id ?? "items");
  const initialId = urlParams.get("id") ? Number(urlParams.get("id")) : undefined;

  const handleTabChange = (tab: string) => {
    setLocation(`/master-data?tab=${tab}`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Master Data</h2>
        <p className="text-muted-foreground">
          Manage items, suppliers, customers, warehouses, and your chart of accounts.
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="mb-4">
          {TABS.map(({ id, label, icon: Icon }) => (
            <TabsTrigger key={id} value={id} className="gap-1.5">
              <Icon className="h-4 w-4" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="items" className="mt-0">
          <ItemsTab initialId={activeTab === "items" ? initialId : undefined} />
        </TabsContent>
        <TabsContent value="suppliers" className="mt-0">
          <SuppliersTab initialId={activeTab === "suppliers" ? initialId : undefined} />
        </TabsContent>
        <TabsContent value="customers" className="mt-0">
          <CustomersTab initialId={activeTab === "customers" ? initialId : undefined} />
        </TabsContent>
        <TabsContent value="warehouses" className="mt-0">
          <WarehousesTab initialId={activeTab === "warehouses" ? initialId : undefined} />
        </TabsContent>
        <TabsContent value="gl-accounts" className="mt-0">
          <GlAccountsTab initialId={activeTab === "gl-accounts" ? initialId : undefined} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
