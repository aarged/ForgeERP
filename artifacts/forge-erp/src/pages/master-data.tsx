import { useState, useCallback, useEffect } from "react";
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
} from "@workspace/api-client-react";
import type {
  CreateItemBody,
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
  ChevronDown,
} from "lucide-react";

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmtDate(d: Date | null | undefined) {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    day: "2-digit",
    month: "short",
    year: "numeric",
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
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isPending}>
            {isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
              <Controller
                control={control}
                name="itemType"
                render={({ field }) => (
                  <Select value={field.value ?? "stock"} onValueChange={field.onChange}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="stock">Stock</SelectItem>
                      <SelectItem value="service">Service</SelectItem>
                      <SelectItem value="charge">Charge</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </FormField>
          </div>
          <FormField label="Name" required>
            <Input {...register("name", { required: true })} placeholder="Item name" />
            {errors.name && <p className="text-xs text-destructive">Required</p>}
          </FormField>
          <FormField label="Description">
            <Textarea {...register("description")} placeholder="Optional description" rows={2} />
          </FormField>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Unit of Measure">
              <Input {...register("unitOfMeasure")} placeholder="e.g. EA, KG, BOX" />
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
            <Input {...register("category")} placeholder="e.g. Raw Materials" />
          </FormField>
          <FormField label="Notes">
            <Textarea {...register("notes")} rows={2} />
          </FormField>
          <div className="flex items-center gap-2">
            <Controller
              control={control}
              name="isActive"
              render={({ field }) => (
                <Switch checked={field.value ?? true} onCheckedChange={field.onChange} id="item-active" />
              )}
            />
            <Label htmlFor="item-active">Active</Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving…" : isEdit ? "Save Changes" : "Create Item"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ItemsTab() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<ItemRow | undefined>();
  const [deleteItem, setDeleteItem] = useState<ItemRow | undefined>();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = { q: debouncedSearch || undefined, page, limit: 25 };
  const { data, isLoading } = useListItems(params);
  const deleteM = useDeleteItem();

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getListItemsQueryKey() });
    setPage(1);
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
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search items…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4 mr-1" /> New Item
        </Button>
      </div>

      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>UoM</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 9 }).map((_, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : data?.items?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                  No items found. Create your first item to get started.
                </TableCell>
              </TableRow>
            ) : data?.items?.map((row) => (
              <TableRow key={row.id} className="cursor-pointer hover:bg-muted/50">
                <TableCell className="font-mono text-sm font-medium">{row.code}</TableCell>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">{row.itemType}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{row.category ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.unitOfMeasure ?? "—"}</TableCell>
                <TableCell className="text-right font-mono">{fmtCurrency(row.unitCost)}</TableCell>
                <TableCell className="text-right font-mono">{fmtCurrency(row.salesPrice)}</TableCell>
                <TableCell><ActiveBadge active={row.isActive} /></TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(row)}>
                        <Pencil className="h-4 w-4 mr-2" /> Edit
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
      </Card>

      {(data?.hasMore || page > 1) && (
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">Page {page}</span>
          <Button variant="outline" size="sm" disabled={!data?.hasMore} onClick={() => setPage(p => p + 1)}>
            Next
          </Button>
        </div>
      )}

      <ItemModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        item={editItem}
        onSuccess={refresh}
      />
      <DeleteConfirm
        open={!!deleteItem}
        onOpenChange={(v) => !v && setDeleteItem(undefined)}
        name={deleteItem?.name ?? "item"}
        onConfirm={handleDelete}
        isPending={deleteM.isPending}
      />
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
    defaultValues: {
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
    },
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
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Supplier" : "New Supplier"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Code" required>
              <Input {...register("code", { required: true })} placeholder="SUP-001" />
              {errors.code && <p className="text-xs text-destructive">Required</p>}
            </FormField>
            <FormField label="Currency">
              <Input {...register("currency")} placeholder="AUD" />
            </FormField>
          </div>
          <FormField label="Name" required>
            <Input {...register("name", { required: true })} placeholder="Supplier name" />
            {errors.name && <p className="text-xs text-destructive">Required</p>}
          </FormField>
          <FormField label="Legal Name">
            <Input {...register("legalName")} placeholder="Full legal name" />
          </FormField>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Tax ID / ABN">
              <Input {...register("taxId")} placeholder="ABN or Tax ID" />
            </FormField>
            <FormField label="Payment Terms">
              <Input {...register("paymentTerms")} placeholder="e.g. Net 30" />
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Email">
              <Input {...register("email")} type="email" placeholder="accounts@supplier.com" />
            </FormField>
            <FormField label="Phone">
              <Input {...register("phone")} placeholder="+61 2 1234 5678" />
            </FormField>
          </div>
          <FormField label="Address">
            <Input {...register("addressLine1")} placeholder="Street address" />
          </FormField>
          <div className="grid grid-cols-3 gap-4">
            <FormField label="City">
              <Input {...register("city")} />
            </FormField>
            <FormField label="State">
              <Input {...register("state")} />
            </FormField>
            <FormField label="Postcode">
              <Input {...register("postalCode")} />
            </FormField>
          </div>
          <FormField label="Country">
            <Input {...register("country")} placeholder="Australia" />
          </FormField>
          <FormField label="Credit Limit">
            <Input {...register("creditLimit", { valueAsNumber: true })} type="number" step="0.01" placeholder="0.00" />
          </FormField>
          <FormField label="Notes">
            <Textarea {...register("notes")} rows={2} />
          </FormField>
          <div className="flex items-center gap-2">
            <Controller
              control={control}
              name="isActive"
              render={({ field }) => (
                <Switch checked={field.value ?? true} onCheckedChange={field.onChange} id="sup-active" />
              )}
            />
            <Label htmlFor="sup-active">Active</Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving…" : isEdit ? "Save Changes" : "Create Supplier"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SuppliersTab() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editSupplier, setEditSupplier] = useState<SupplierRow | undefined>();
  const [deleteSupplier, setDeleteSupplier] = useState<SupplierRow | undefined>();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = { q: debouncedSearch || undefined, page, limit: 25 };
  const { data, isLoading } = useListSuppliers(params);
  const deleteM = useDeleteSupplier();

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
    setPage(1);
  }, [queryClient]);

  const handleDelete = async () => {
    if (!deleteSupplier?.id) return;
    try {
      await deleteM.mutateAsync({ id: deleteSupplier.id });
      toast({ title: "Supplier deleted" });
      setDeleteSupplier(undefined);
      refresh();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  };

  const openCreate = () => { setEditSupplier(undefined); setModalOpen(true); };
  const openEdit = (row: SupplierRow) => { setEditSupplier(row); setModalOpen(true); };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search suppliers…" value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        </div>
        <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> New Supplier</Button>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>City</TableHead>
              <TableHead>Country</TableHead>
              <TableHead>Terms</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 9 }).map((_, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : data?.suppliers?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                  No suppliers found. Create your first supplier to get started.
                </TableCell>
              </TableRow>
            ) : data?.suppliers?.map((row) => (
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
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(row)}>
                        <Pencil className="h-4 w-4 mr-2" /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive" onClick={() => setDeleteSupplier(row)}>
                        <Trash2 className="h-4 w-4 mr-2" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      {(data?.hasMore || page > 1) && (
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
          <span className="text-sm text-muted-foreground">Page {page}</span>
          <Button variant="outline" size="sm" disabled={!data?.hasMore} onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      )}
      <SupplierModal open={modalOpen} onOpenChange={setModalOpen} supplier={editSupplier} onSuccess={refresh} />
      <DeleteConfirm
        open={!!deleteSupplier}
        onOpenChange={(v) => !v && setDeleteSupplier(undefined)}
        name={deleteSupplier?.name ?? "supplier"}
        onConfirm={handleDelete}
        isPending={deleteM.isPending}
      />
    </div>
  );
}

// ─── CUSTOMERS TAB ────────────────────────────────────────────────────────────

type CustomerRow = NonNullable<ListCustomersQueryResult["customers"]>[number];

function CustomerModal({
  open,
  onOpenChange,
  customer,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  customer?: CustomerRow;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateCustomer();
  const update = useUpdateCustomer();
  const isEdit = !!customer;

  const { register, control, handleSubmit, reset, formState: { errors } } = useForm<CreateCustomerBody>({
    defaultValues: {
      code: customer?.code ?? "",
      name: customer?.name ?? "",
      legalName: customer?.legalName ?? "",
      taxId: customer?.taxId ?? "",
      email: customer?.email ?? "",
      phone: customer?.phone ?? "",
      billingAddressLine1: customer?.billingAddressLine1 ?? "",
      billingCity: customer?.billingCity ?? "",
      billingState: customer?.billingState ?? "",
      billingPostalCode: customer?.billingPostalCode ?? "",
      billingCountry: customer?.billingCountry ?? "",
      creditLimit: customer?.creditLimit ? Number(customer.creditLimit) : undefined,
      paymentTerms: customer?.paymentTerms ?? "",
      currency: customer?.currency ?? "AUD",
      isActive: customer?.isActive ?? true,
      notes: customer?.notes ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      reset({
        code: customer?.code ?? "",
        name: customer?.name ?? "",
        legalName: customer?.legalName ?? "",
        taxId: customer?.taxId ?? "",
        email: customer?.email ?? "",
        phone: customer?.phone ?? "",
        billingAddressLine1: customer?.billingAddressLine1 ?? "",
        billingCity: customer?.billingCity ?? "",
        billingState: customer?.billingState ?? "",
        billingPostalCode: customer?.billingPostalCode ?? "",
        billingCountry: customer?.billingCountry ?? "",
        creditLimit: customer?.creditLimit ? Number(customer.creditLimit) : undefined,
        paymentTerms: customer?.paymentTerms ?? "",
        currency: customer?.currency ?? "AUD",
        isActive: customer?.isActive ?? true,
        notes: customer?.notes ?? "",
      });
    }
  }, [open, customer, reset]);

  const onSubmit = handleSubmit(async (data) => {
    try {
      if (isEdit && customer?.id) {
        await update.mutateAsync({ id: customer.id, data });
        toast({ title: "Customer updated" });
      } else {
        await create.mutateAsync({ data });
        toast({ title: "Customer created" });
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
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Customer" : "New Customer"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Code" required>
              <Input {...register("code", { required: true })} placeholder="CUST-001" />
              {errors.code && <p className="text-xs text-destructive">Required</p>}
            </FormField>
            <FormField label="Currency">
              <Input {...register("currency")} placeholder="AUD" />
            </FormField>
          </div>
          <FormField label="Name" required>
            <Input {...register("name", { required: true })} placeholder="Customer name" />
            {errors.name && <p className="text-xs text-destructive">Required</p>}
          </FormField>
          <FormField label="Legal Name">
            <Input {...register("legalName")} />
          </FormField>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Tax ID / ABN">
              <Input {...register("taxId")} />
            </FormField>
            <FormField label="Payment Terms">
              <Input {...register("paymentTerms")} placeholder="Net 30" />
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Email">
              <Input {...register("email")} type="email" />
            </FormField>
            <FormField label="Phone">
              <Input {...register("phone")} />
            </FormField>
          </div>
          <FormField label="Billing Address">
            <Input {...register("billingAddressLine1")} placeholder="Street address" />
          </FormField>
          <div className="grid grid-cols-3 gap-4">
            <FormField label="City">
              <Input {...register("billingCity")} />
            </FormField>
            <FormField label="State">
              <Input {...register("billingState")} />
            </FormField>
            <FormField label="Postcode">
              <Input {...register("billingPostalCode")} />
            </FormField>
          </div>
          <FormField label="Country">
            <Input {...register("billingCountry")} placeholder="Australia" />
          </FormField>
          <FormField label="Credit Limit">
            <Input {...register("creditLimit", { valueAsNumber: true })} type="number" step="0.01" placeholder="0.00" />
          </FormField>
          <FormField label="Notes">
            <Textarea {...register("notes")} rows={2} />
          </FormField>
          <div className="flex items-center gap-2">
            <Controller
              control={control}
              name="isActive"
              render={({ field }) => (
                <Switch checked={field.value ?? true} onCheckedChange={field.onChange} id="cust-active" />
              )}
            />
            <Label htmlFor="cust-active">Active</Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving…" : isEdit ? "Save Changes" : "Create Customer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CustomersTab() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editCustomer, setEditCustomer] = useState<CustomerRow | undefined>();
  const [deleteCustomer, setDeleteCustomer] = useState<CustomerRow | undefined>();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = { q: debouncedSearch || undefined, page, limit: 25 };
  const { data, isLoading } = useListCustomers(params);
  const deleteM = useDeleteCustomer();

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
    setPage(1);
  }, [queryClient]);

  const handleDelete = async () => {
    if (!deleteCustomer?.id) return;
    try {
      await deleteM.mutateAsync({ id: deleteCustomer.id });
      toast({ title: "Customer deleted" });
      setDeleteCustomer(undefined);
      refresh();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  };

  const openCreate = () => { setEditCustomer(undefined); setModalOpen(true); };
  const openEdit = (row: CustomerRow) => { setEditCustomer(row); setModalOpen(true); };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search customers…" value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        </div>
        <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> New Customer</Button>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Phone</TableHead>
              <TableHead>Billing City</TableHead>
              <TableHead>Terms</TableHead>
              <TableHead className="text-right">Credit Limit</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 9 }).map((_, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : data?.customers?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                  No customers found. Create your first customer to get started.
                </TableCell>
              </TableRow>
            ) : data?.customers?.map((row) => (
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
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(row)}>
                        <Pencil className="h-4 w-4 mr-2" /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive" onClick={() => setDeleteCustomer(row)}>
                        <Trash2 className="h-4 w-4 mr-2" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      {(data?.hasMore || page > 1) && (
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
          <span className="text-sm text-muted-foreground">Page {page}</span>
          <Button variant="outline" size="sm" disabled={!data?.hasMore} onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      )}
      <CustomerModal open={modalOpen} onOpenChange={setModalOpen} customer={editCustomer} onSuccess={refresh} />
      <DeleteConfirm
        open={!!deleteCustomer}
        onOpenChange={(v) => !v && setDeleteCustomer(undefined)}
        name={deleteCustomer?.name ?? "customer"}
        onConfirm={handleDelete}
        isPending={deleteM.isPending}
      />
    </div>
  );
}

// ─── WAREHOUSES TAB ───────────────────────────────────────────────────────────

type WarehouseRow = NonNullable<ListWarehousesQueryResult["warehouses"]>[number];

function WarehouseModal({
  open,
  onOpenChange,
  warehouse,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  warehouse?: WarehouseRow;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateWarehouse();
  const update = useUpdateWarehouse();
  const isEdit = !!warehouse;

  const { register, control, handleSubmit, reset, formState: { errors } } = useForm<CreateWarehouseBody>({
    defaultValues: {
      name: warehouse?.name ?? "",
      code: warehouse?.code ?? "",
      addressLine1: warehouse?.addressLine1 ?? "",
      city: warehouse?.city ?? "",
      state: warehouse?.state ?? "",
      country: warehouse?.country ?? "",
      isDefault: (warehouse?.isDefault as CreateWarehouseBody["isDefault"]) ?? "false",
      isActive: warehouse?.isActive ?? true,
      notes: warehouse?.notes ?? "",
    },
  });

  useEffect(() => {
    if (open) {
      reset({
        name: warehouse?.name ?? "",
        code: warehouse?.code ?? "",
        addressLine1: warehouse?.addressLine1 ?? "",
        city: warehouse?.city ?? "",
        state: warehouse?.state ?? "",
        country: warehouse?.country ?? "",
        isDefault: (warehouse?.isDefault as CreateWarehouseBody["isDefault"]) ?? "false",
        isActive: warehouse?.isActive ?? true,
        notes: warehouse?.notes ?? "",
      });
    }
  }, [open, warehouse, reset]);

  const onSubmit = handleSubmit(async (data) => {
    try {
      if (isEdit && warehouse?.id) {
        await update.mutateAsync({ id: warehouse.id, data });
        toast({ title: "Warehouse updated" });
      } else {
        await create.mutateAsync({ data });
        toast({ title: "Warehouse created" });
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
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Warehouse" : "New Warehouse"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <FormField label="Name" required>
            <Input {...register("name", { required: true })} placeholder="Main Warehouse" />
            {errors.name && <p className="text-xs text-destructive">Required</p>}
          </FormField>
          <FormField label="Code">
            <Input {...register("code")} placeholder="WH-MAIN" />
          </FormField>
          <FormField label="Address">
            <Input {...register("addressLine1")} placeholder="Street address" />
          </FormField>
          <div className="grid grid-cols-3 gap-4">
            <FormField label="City">
              <Input {...register("city")} />
            </FormField>
            <FormField label="State">
              <Input {...register("state")} />
            </FormField>
            <FormField label="Country">
              <Input {...register("country")} />
            </FormField>
          </div>
          <FormField label="Notes">
            <Textarea {...register("notes")} rows={2} />
          </FormField>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Controller
                control={control}
                name="isDefault"
                render={({ field }) => (
                  <Switch
                    checked={field.value === "true"}
                    onCheckedChange={(v) => field.onChange(v ? "true" : "false")}
                    id="wh-default"
                  />
                )}
              />
              <Label htmlFor="wh-default">Default Warehouse</Label>
            </div>
            <div className="flex items-center gap-2">
              <Controller
                control={control}
                name="isActive"
                render={({ field }) => (
                  <Switch checked={field.value ?? true} onCheckedChange={field.onChange} id="wh-active" />
                )}
              />
              <Label htmlFor="wh-active">Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving…" : isEdit ? "Save Changes" : "Create Warehouse"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function WarehousesTab() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [editWarehouse, setEditWarehouse] = useState<WarehouseRow | undefined>();
  const [deleteWarehouse, setDeleteWarehouse] = useState<WarehouseRow | undefined>();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = { q: debouncedSearch || undefined, page, limit: 25 };
  const { data, isLoading } = useListWarehouses(params);
  const deleteM = useDeleteWarehouse();

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getListWarehousesQueryKey() });
    setPage(1);
  }, [queryClient]);

  const handleDelete = async () => {
    if (!deleteWarehouse?.id) return;
    try {
      await deleteM.mutateAsync({ id: deleteWarehouse.id });
      toast({ title: "Warehouse deleted" });
      setDeleteWarehouse(undefined);
      refresh();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  };

  const openCreate = () => { setEditWarehouse(undefined); setModalOpen(true); };
  const openEdit = (row: WarehouseRow) => { setEditWarehouse(row); setModalOpen(true); };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search warehouses…" value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        </div>
        <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> New Warehouse</Button>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Code</TableHead>
              <TableHead>City</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Country</TableHead>
              <TableHead>Default</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 8 }).map((_, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : data?.warehouses?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                  No warehouses found. Create your first warehouse to get started.
                </TableCell>
              </TableRow>
            ) : data?.warehouses?.map((row) => (
              <TableRow key={row.id} className="hover:bg-muted/50">
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell className="font-mono text-sm">{row.code ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.city ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.state ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">{row.country ?? "—"}</TableCell>
                <TableCell>
                  {row.isDefault === "true" ? (
                    <Badge variant="default" className="bg-blue-100 text-blue-800 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-400">Default</Badge>
                  ) : "—"}
                </TableCell>
                <TableCell><ActiveBadge active={row.isActive} /></TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => openEdit(row)}>
                        <Pencil className="h-4 w-4 mr-2" /> Edit
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive" onClick={() => setDeleteWarehouse(row)}>
                        <Trash2 className="h-4 w-4 mr-2" /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      {(data?.hasMore || page > 1) && (
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
          <span className="text-sm text-muted-foreground">Page {page}</span>
          <Button variant="outline" size="sm" disabled={!data?.hasMore} onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      )}
      <WarehouseModal open={modalOpen} onOpenChange={setModalOpen} warehouse={editWarehouse} onSuccess={refresh} />
      <DeleteConfirm
        open={!!deleteWarehouse}
        onOpenChange={(v) => !v && setDeleteWarehouse(undefined)}
        name={deleteWarehouse?.name ?? "warehouse"}
        onConfirm={handleDelete}
        isPending={deleteM.isPending}
      />
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

function GlAccountModal({
  open,
  onOpenChange,
  account,
  allAccounts,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  account?: GlAccountRow;
  allAccounts: GlAccountRow[];
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateGlAccount();
  const update = useUpdateGlAccount();
  const isEdit = !!account;

  const { register, control, handleSubmit, reset, formState: { errors } } = useForm<CreateGlAccountBody>({
    defaultValues: {
      code: account?.code ?? "",
      name: account?.name ?? "",
      accountType: (account?.accountType as CreateGlAccountBody["accountType"]) ?? "asset",
      description: account?.description ?? "",
      taxCode: account?.taxCode ?? "",
      parentId: account?.parentId ?? undefined,
      isPosting: account?.isPosting ?? true,
      isActive: account?.isActive ?? true,
    },
  });

  useEffect(() => {
    if (open) {
      reset({
        code: account?.code ?? "",
        name: account?.name ?? "",
        accountType: (account?.accountType as CreateGlAccountBody["accountType"]) ?? "asset",
        description: account?.description ?? "",
        taxCode: account?.taxCode ?? "",
        parentId: account?.parentId ?? undefined,
        isPosting: account?.isPosting ?? true,
        isActive: account?.isActive ?? true,
      });
    }
  }, [open, account, reset]);

  const onSubmit = handleSubmit(async (data) => {
    try {
      if (isEdit && account?.id) {
        await update.mutateAsync({ id: account.id, data });
        toast({ title: "GL account updated" });
      } else {
        await create.mutateAsync({ data });
        toast({ title: "GL account created" });
      }
      onSuccess();
      onOpenChange(false);
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  });

  const isPending = create.isPending || update.isPending;
  const parentOptions = allAccounts.filter((a) => a.id !== account?.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit GL Account" : "New GL Account"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Code" required>
              <Input {...register("code", { required: true })} placeholder="1000" />
              {errors.code && <p className="text-xs text-destructive">Required</p>}
            </FormField>
            <FormField label="Account Type" required>
              <Controller
                control={control}
                name="accountType"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {GL_ACCOUNT_TYPES.map((t) => (
                        <SelectItem key={t} value={t} className="capitalize">{t.charAt(0).toUpperCase() + t.slice(1)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </FormField>
          </div>
          <FormField label="Name" required>
            <Input {...register("name", { required: true })} placeholder="Cash and Cash Equivalents" />
            {errors.name && <p className="text-xs text-destructive">Required</p>}
          </FormField>
          <FormField label="Parent Account">
            <Controller
              control={control}
              name="parentId"
              render={({ field }) => (
                <Select
                  value={field.value?.toString() ?? "none"}
                  onValueChange={(v) => field.onChange(v === "none" ? undefined : Number(v))}
                >
                  <SelectTrigger><SelectValue placeholder="No parent" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No parent</SelectItem>
                    {parentOptions.map((a) => (
                      <SelectItem key={a.id} value={a.id!.toString()}>
                        {a.code} — {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </FormField>
          <FormField label="Description">
            <Textarea {...register("description")} rows={2} />
          </FormField>
          <FormField label="Tax Code">
            <Input {...register("taxCode")} placeholder="e.g. GST, CAP" />
          </FormField>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Controller
                control={control}
                name="isPosting"
                render={({ field }) => (
                  <Switch checked={field.value ?? true} onCheckedChange={field.onChange} id="gl-posting" />
                )}
              />
              <Label htmlFor="gl-posting">Posting Account</Label>
            </div>
            <div className="flex items-center gap-2">
              <Controller
                control={control}
                name="isActive"
                render={({ field }) => (
                  <Switch checked={field.value ?? true} onCheckedChange={field.onChange} id="gl-active" />
                )}
              />
              <Label htmlFor="gl-active">Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>Cancel</Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? "Saving…" : isEdit ? "Save Changes" : "Create Account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ImportTemplateDialog({
  open,
  onOpenChange,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const importTemplate = useImportGlAccountTemplate();
  const [template, setTemplate] = useState<GlTemplateImportBodyTemplate>("standard");

  const handleImport = async () => {
    try {
      await importTemplate.mutateAsync({ data: { template } });
      toast({ title: "Chart of accounts imported", description: `Imported ${template} template.` });
      onSuccess();
      onOpenChange(false);
    } catch (e: unknown) {
      toast({ title: "Import failed", description: (e as Error).message, variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Import Chart of Accounts</DialogTitle>
          <DialogDescription>
            Import a pre-built chart of accounts template. Existing accounts with matching codes will be skipped.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <FormField label="Template">
            <Select value={template} onValueChange={(v) => setTemplate(v as GlTemplateImportBodyTemplate)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {GL_TEMPLATES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                ))}
              </SelectContent>
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

const TYPE_COLORS: Record<string, string> = {
  asset: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  liability: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  equity: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
  revenue: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  expense: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
};

function GlAccountsTab() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<GlAccountRow | undefined>();
  const [deleteAccount, setDeleteAccount] = useState<GlAccountRow | undefined>();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const params = {
    q: debouncedSearch || undefined,
    accountType: typeFilter !== "all" ? typeFilter : undefined,
    page,
    limit: 50,
  };
  const { data, isLoading } = useListGlAccounts(params);
  const { data: allData } = useListGlAccounts({ limit: 500 });
  const deleteM = useDeleteGlAccount();

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: getListGlAccountsQueryKey() });
    setPage(1);
  }, [queryClient]);

  const handleDelete = async () => {
    if (!deleteAccount?.id) return;
    try {
      await deleteM.mutateAsync({ id: deleteAccount.id });
      toast({ title: "GL account deleted" });
      setDeleteAccount(undefined);
      refresh();
    } catch (e: unknown) {
      toast({ title: "Error", description: (e as Error).message, variant: "destructive" });
    }
  };

  const openCreate = () => { setEditAccount(undefined); setModalOpen(true); };
  const openEdit = (row: GlAccountRow) => { setEditAccount(row); setModalOpen(true); };

  const allAccounts = allData?.accounts ?? [];
  const accountMap = new Map(allAccounts.map((a) => [a.id, a]));

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search accounts…" value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        </div>
        <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v); setPage(1); }}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {GL_ACCOUNT_TYPES.map((t) => (
              <SelectItem key={t} value={t} className="capitalize">{t.charAt(0).toUpperCase() + t.slice(1)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex gap-2 ml-auto">
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Download className="h-4 w-4 mr-1" /> Import Template
          </Button>
          <Button onClick={openCreate}><Plus className="h-4 w-4 mr-1" /> New Account</Button>
        </div>
      </div>
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Parent</TableHead>
              <TableHead>Tax Code</TableHead>
              <TableHead>Posting</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 8 }).map((_, j) => (
                    <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                  ))}
                </TableRow>
              ))
            ) : data?.accounts?.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                  No GL accounts found. Import a template or create your first account.
                </TableCell>
              </TableRow>
            ) : data?.accounts?.map((row) => {
              const parent = row.parentId ? accountMap.get(row.parentId) : null;
              return (
                <TableRow key={row.id} className="hover:bg-muted/50">
                  <TableCell className="font-mono text-sm font-medium">{row.code}</TableCell>
                  <TableCell className="font-medium">{row.name}</TableCell>
                  <TableCell>
                    <Badge
                      variant="secondary"
                      className={`capitalize ${TYPE_COLORS[row.accountType ?? ""] ?? ""}`}
                    >
                      {row.accountType}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {parent ? `${parent.code} — ${parent.name}` : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{row.taxCode ?? "—"}</TableCell>
                  <TableCell>
                    {row.isPosting ? (
                      <Badge variant="outline" className="text-xs">Posting</Badge>
                    ) : (
                      <Badge variant="secondary" className="text-xs">Header</Badge>
                    )}
                  </TableCell>
                  <TableCell><ActiveBadge active={row.isActive} /></TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEdit(row)}>
                          <Pencil className="h-4 w-4 mr-2" /> Edit
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="text-destructive" onClick={() => setDeleteAccount(row)}>
                          <Trash2 className="h-4 w-4 mr-2" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
      {(data?.hasMore || page > 1) && (
        <div className="flex items-center justify-between">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Previous</Button>
          <span className="text-sm text-muted-foreground">Page {page}</span>
          <Button variant="outline" size="sm" disabled={!data?.hasMore} onClick={() => setPage(p => p + 1)}>Next</Button>
        </div>
      )}
      <GlAccountModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        account={editAccount}
        allAccounts={allAccounts}
        onSuccess={refresh}
      />
      <ImportTemplateDialog open={importOpen} onOpenChange={setImportOpen} onSuccess={refresh} />
      <DeleteConfirm
        open={!!deleteAccount}
        onOpenChange={(v) => !v && setDeleteAccount(undefined)}
        name={deleteAccount?.name ?? "GL account"}
        onConfirm={handleDelete}
        isPending={deleteM.isPending}
      />
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
  const params = new URLSearchParams(window.location.search);
  const rawTab = params.get("tab");
  const activeTab: TabId = (TABS.find((t) => t.id === rawTab)?.id ?? "items");

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

        <TabsContent value="items" className="mt-0"><ItemsTab /></TabsContent>
        <TabsContent value="suppliers" className="mt-0"><SuppliersTab /></TabsContent>
        <TabsContent value="customers" className="mt-0"><CustomersTab /></TabsContent>
        <TabsContent value="warehouses" className="mt-0"><WarehousesTab /></TabsContent>
        <TabsContent value="gl-accounts" className="mt-0"><GlAccountsTab /></TabsContent>
      </Tabs>
    </div>
  );
}
