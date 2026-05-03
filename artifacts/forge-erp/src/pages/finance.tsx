import React, { useEffect, useRef, useState } from "react";
import Papa from "papaparse";
import { useQueryClient } from "@tanstack/react-query";
import { useForm, useFieldArray, Controller } from "react-hook-form";
import {
  useGetFinanceJournals,
  getGetFinanceJournalsQueryKey,
  usePostFinanceJournals,
  usePostFinanceJournalsIdReverse,
  useApproveFinanceJournal,
  getExportFinanceJournalsCsvUrl,
  getExportFinanceJournalsXlsxUrl,
  useGetFinanceTrialBalance,
  getGetFinanceTrialBalanceQueryKey,
  useGetFinanceAccountMovements,
  getGetFinanceAccountMovementsQueryKey,
  useListGlAccounts,
  useCreateGlAccount,
  useUpdateGlAccount,
  useImportGlAccounts,
  getListGlAccountsQueryKey,
  type GlPosting,
  type MasterGlAccount,
  type CreateGlAccountBody,
  type BulkImportResult,
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
  DialogDescription,
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
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Plus, Search, Eye, Download, Undo2, ChevronDown, ChevronRight, FileText, CheckCircle2, Pencil, Power, Upload } from "lucide-react";

// ── Local DTOs ────────────────────────────────────────────────────────────────

interface JournalLine { accountCode: string; accountName: string; debit: number; credit: number; description?: string; }
interface FormValues { memo: string; postingDate: string; attachmentUrl?: string; lines: JournalLine[]; }
interface TrialBalanceAccount { accountId: number; accountCode: string; accountName: string; accountType: string | null; openingBalance: number; periodDebit: number; periodCredit: number; closingBalance: number; }
interface AccountMovement { postingId: number; postingCode: string; entityType: string; postedAt: string | null; createdAt: string; debit: number; credit: number; description: string; balance: number; }

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";
const STATUS_VARIANT: Record<string, BadgeVariant> = {
  posted: "default",
  draft: "secondary",
  reversed: "destructive",
};

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt(n: number | string | null | undefined, isCurrency = true): string {
  if (n == null) return "—";
  const num = Number(n);
  if (num === 0) return isCurrency ? "$0.00" : "0";
  return new Intl.NumberFormat("en-US", {
    style: isCurrency ? "currency" : "decimal",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(num);
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString();
}

function StatusBadge({ status }: { status: string | undefined }) {
  return <Badge variant={STATUS_VARIANT[status ?? ""] ?? "outline"}>{status}</Badge>;
}

function JournalTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  
  const [showCreate, setShowCreate] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data, isLoading } = useGetFinanceJournals({
    status: status !== "all" ? status : undefined,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    limit: 50,
  }, { query: { queryKey: getGetFinanceJournalsQueryKey({ status, fromDate, toDate }) }});

  const { data: glAccounts } = useListGlAccounts({ limit: 500 });
  const postMut = usePostFinanceJournals();
  const reverseMut = usePostFinanceJournalsIdReverse();
  const approveMut = useApproveFinanceJournal();

  const form = useForm<FormValues>({
    defaultValues: {
      memo: "",
      postingDate: new Date().toISOString().split("T")[0],
      attachmentUrl: "",
      lines: [
        { accountCode: "", accountName: "", debit: 0, credit: 0, description: "" },
        { accountCode: "", accountName: "", debit: 0, credit: 0, description: "" }
      ]
    }
  });
  
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "lines" });

  const totalDebit = form.watch("lines").reduce((sum, l) => sum + (Number(l.debit) || 0), 0);
  const totalCredit = form.watch("lines").reduce((sum, l) => sum + (Number(l.credit) || 0), 0);
  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.01;

  async function onSubmit(vals: FormValues) {
    if (!isBalanced) {
      toast({ title: "Journal not balanced", description: "Total debit must equal total credit", variant: "destructive" });
      return;
    }
    try {
      const result = await postMut.mutateAsync({ data: { 
        memo: vals.memo, 
        postingDate: vals.postingDate,
        attachmentUrl: vals.attachmentUrl || undefined,
        lines: vals.lines.filter((l) => l.accountCode) 
      }});
      const r = result as { requiresApproval?: boolean; approvalThreshold?: number };
      if (r?.requiresApproval) {
        toast({ title: "Journal saved — pending approval", description: `Journals over $${(r.approvalThreshold ?? 10000).toLocaleString()} require manager approval before posting.` });
      } else {
        toast({ title: "Journal entry posted" });
      }
      setShowCreate(false);
      form.reset();
      qc.invalidateQueries({ queryKey: getGetFinanceJournalsQueryKey({}) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "An unexpected error occurred";
      toast({ title: "Error", description: msg, variant: "destructive" });
    }
  }

  async function onReverse(id: number) {
    if (!confirm("Are you sure you want to reverse this journal?")) return;
    try {
      await reverseMut.mutateAsync({ id, data: { memo: "Manual reversal" } });
      toast({ title: "Journal reversed" });
      qc.invalidateQueries({ queryKey: getGetFinanceJournalsQueryKey({}) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "An unexpected error occurred";
      toast({ title: "Error", description: msg, variant: "destructive" });
    }
  }

  async function onApprove(id: number) {
    try {
      await approveMut.mutateAsync({ id });
      toast({ title: "Journal approved and posted" });
      qc.invalidateQueries({ queryKey: getGetFinanceJournalsQueryKey({}) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "An unexpected error occurred";
      toast({ title: "Approval failed", description: msg, variant: "destructive" });
    }
  }

  const rows: GlPosting[] = data?.data ?? [];
  const filtered = rows.filter(r => !search || r.code?.toLowerCase().includes(search.toLowerCase()) || r.notes?.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <div className="flex gap-2 flex-wrap">
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search journals…" className="pl-8" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="posted">Posted</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="reversed">Reversed</SelectItem>
            </SelectContent>
          </Select>
          <Input type="date" className="w-40" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <Input type="date" className="w-40" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => {
            const csvUrl = getExportFinanceJournalsCsvUrl({
              ...(status !== "all" ? { status } : {}),
              ...(fromDate ? { fromDate } : {}),
              ...(toDate ? { toDate } : {}),
            });
            window.open(csvUrl, "_blank");
          }}><Download className="h-4 w-4 mr-2" />CSV</Button>
          <Button variant="outline" onClick={() => {
            const xlsxUrl = getExportFinanceJournalsXlsxUrl({
              ...(status !== "all" ? { status } : {}),
              ...(fromDate ? { fromDate } : {}),
              ...(toDate ? { toDate } : {}),
            });
            window.open(xlsxUrl, "_blank");
          }}><FileText className="h-4 w-4 mr-2" />Excel</Button>
          <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4 mr-2" />Manual Entry</Button>
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[50px]"></TableHead>
              <TableHead>Code</TableHead>
              <TableHead>Date</TableHead>
              <TableHead>Memo</TableHead>
              <TableHead>Source</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[100px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8">Loading journals...</TableCell></TableRow>
            ) : filtered.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="text-center py-8">No journals found</TableCell></TableRow>
            ) : filtered.map((r) => (
              <React.Fragment key={r.id}>
                <TableRow className={expandedId === r.id ? "bg-muted/50" : ""}>
                  <TableCell>
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setExpandedId(expandedId === r.id ? null : (r.id ?? null))}>
                      {expandedId === r.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </Button>
                  </TableCell>
                  <TableCell className="font-mono font-medium">{r.code}</TableCell>
                  <TableCell>{fmtDate(r.postedAt || r.createdAt)}</TableCell>
                  <TableCell>{r.notes}</TableCell>
                  <TableCell className="capitalize text-muted-foreground">{r.entityType?.replace("_", " ") || "Manual"}</TableCell>
                  <TableCell className="text-right font-medium">{fmt(r.totalDebit)}</TableCell>
                  <TableCell><StatusBadge status={r.status} /></TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {r.status === "draft" && (
                        <Button variant="ghost" size="sm" title="Approve" onClick={() => r.id && onApprove(r.id)} className="text-emerald-600">
                          <CheckCircle2 className="h-4 w-4" />
                        </Button>
                      )}
                      {r.status === "posted" && (
                        <Button variant="ghost" size="sm" title="Reverse" onClick={() => r.id && onReverse(r.id)}>
                          <Undo2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
                {expandedId === r.id && (
                  <TableRow className="bg-muted/50">
                    <TableCell colSpan={8} className="p-0 border-b-0">
                      <div className="p-4 pl-14">
                        <Table className="bg-background border rounded-md shadow-sm">
                          <TableHeader>
                            <TableRow>
                              <TableHead>Account</TableHead>
                              <TableHead>Description</TableHead>
                              <TableHead className="text-right">Debit</TableHead>
                              <TableHead className="text-right">Credit</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {((r.lines as unknown as JournalLine[]) || []).map((l, i) => (
                              <TableRow key={i}>
                                <TableCell className="font-medium text-xs">
                                  {l.accountCode} <span className="text-muted-foreground font-normal">{l.accountName}</span>
                                </TableCell>
                                <TableCell className="text-xs">{l.description}</TableCell>
                                <TableCell className="text-right text-xs font-mono">{fmt(l.debit)}</TableCell>
                                <TableCell className="text-right text-xs font-mono">{fmt(l.credit)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>New Manual Journal</DialogTitle></DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Posting Date *</Label>
                <Input type="date" {...form.register("postingDate", { required: true })} />
              </div>
              <div>
                <Label>Memo *</Label>
                <Input {...form.register("memo", { required: true })} placeholder="Reason for journal..." />
              </div>
            </div>

            <div>
              <Label>Attachment URL <span className="text-muted-foreground text-xs">(optional — link to supporting document)</span></Label>
              <Input {...form.register("attachmentUrl")} type="url" placeholder="https://docs.example.com/invoice-123.pdf" />
            </div>

            <div className="space-y-2 mt-4">
              <div className="flex items-center justify-between">
                <Label>Journal Lines</Label>
                <Button type="button" size="sm" variant="outline" onClick={() => append({ accountCode: "", accountName: "", debit: 0, credit: 0, description: "" })}>
                  <Plus className="h-3 w-3 mr-1" />Add Line
                </Button>
              </div>
              
              <div className="border rounded-md">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Account</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="w-32 text-right">Debit</TableHead>
                      <TableHead className="w-32 text-right">Credit</TableHead>
                      <TableHead className="w-12"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fields.map((field, i) => (
                      <TableRow key={field.id}>
                        <TableCell>
                          <Select 
                            value={form.watch(`lines.${i}.accountCode`)} 
                            onValueChange={(v) => {
                              const acc = glAccounts?.accounts?.find(a => a.code === v);
                              form.setValue(`lines.${i}.accountCode`, v);
                              form.setValue(`lines.${i}.accountName`, acc?.name || "");
                            }}
                          >
                            <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
                            <SelectContent>
                              {(glAccounts?.accounts || []).map(a => (
                                <SelectItem key={a.id} value={a.code ?? ""}>{a.code} - {a.name}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Input {...form.register(`lines.${i}.description`)} placeholder="Line detail..." />
                        </TableCell>
                        <TableCell>
                          <Input type="number" step="0.01" {...form.register(`lines.${i}.debit`, { valueAsNumber: true })} className="text-right font-mono" />
                        </TableCell>
                        <TableCell>
                          <Input type="number" step="0.01" {...form.register(`lines.${i}.credit`, { valueAsNumber: true })} className="text-right font-mono" />
                        </TableCell>
                        <TableCell>
                          <Button type="button" size="sm" variant="ghost" onClick={() => remove(i)} className="text-destructive h-8 w-8 p-0">✕</Button>
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="bg-muted/30 font-medium">
                      <TableCell colSpan={2} className="text-right">Totals</TableCell>
                      <TableCell className="text-right font-mono">{fmt(totalDebit)}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(totalCredit)}</TableCell>
                      <TableCell></TableCell>
                    </TableRow>
                    <TableRow className="bg-muted/10 border-0">
                      <TableCell colSpan={5} className="text-right py-2 text-sm border-0">
                        <span className={isBalanced ? "text-emerald-600 font-medium" : "text-destructive font-medium"}>
                          {isBalanced ? "Balanced" : `Out of balance by ${fmt(Math.abs(totalDebit - totalCredit))}`}
                        </span>
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="submit" disabled={!isBalanced || postMut.isPending}>
                {postMut.isPending ? "Posting..." : "Post Journal"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function TrialBalanceTab() {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState(new Date().toISOString().split("T")[0]);

  const { data, isLoading } = useGetFinanceTrialBalance({
    fromDate: fromDate || undefined,
    toDate: toDate || undefined
  }, { query: { queryKey: getGetFinanceTrialBalanceQueryKey({ fromDate, toDate }) }});

  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <div className="flex gap-2">
          <Input type="date" className="w-40" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          <Input type="date" className="w-40" value={toDate} onChange={(e) => setToDate(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => window.open(`/api/finance/trial-balance/pdf?fromDate=${fromDate}&toDate=${toDate}`, '_blank')}>
            <FileText className="h-4 w-4 mr-2" /> Export PDF
          </Button>
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account Code</TableHead>
              <TableHead>Account Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Opening Balance</TableHead>
              <TableHead className="text-right">Period Debit</TableHead>
              <TableHead className="text-right">Period Credit</TableHead>
              <TableHead className="text-right">Closing Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={7} className="text-center py-8">Loading trial balance...</TableCell></TableRow>
            ) : !data?.accounts?.length ? (
              <TableRow><TableCell colSpan={7} className="text-center py-8">No activity found</TableCell></TableRow>
            ) : (
              <>
                {(data.accounts as unknown as TrialBalanceAccount[]).map((a) => (
                  <TableRow key={a.accountId}>
                    <TableCell className="font-mono">{a.accountCode}</TableCell>
                    <TableCell className="font-medium">{a.accountName}</TableCell>
                    <TableCell className="capitalize">{String(a.accountType ?? "").replace("_", " ")}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(Math.abs(Number(a.openingBalance ?? 0)))} {Number(a.openingBalance ?? 0) >= 0 ? "DR" : "CR"}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(a.periodDebit)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(a.periodCredit)}</TableCell>
                    <TableCell className="text-right font-mono font-medium">{fmt(Math.abs(Number(a.closingBalance ?? 0)))} {Number(a.closingBalance ?? 0) >= 0 ? "DR" : "CR"}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/50 font-bold border-t-2 border-primary">
                  <TableCell colSpan={4} className="text-right">Totals</TableCell>
                  <TableCell className="text-right font-mono">{fmt(data.totals?.debit)}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(data.totals?.credit)}</TableCell>
                  <TableCell></TableCell>
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function AccountLedgerTab() {
  const [accountCode, setAccountCode] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  
  const { data, isLoading } = useGetFinanceAccountMovements({
    accountCode: accountCode || "INVALID",
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    limit: 100
  }, { query: { 
    enabled: !!accountCode,
    queryKey: getGetFinanceAccountMovementsQueryKey({ accountCode, fromDate, toDate }) 
  }});

  const { data: glAccounts } = useListGlAccounts({ limit: 500 });

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Select value={accountCode} onValueChange={setAccountCode}>
          <SelectTrigger className="w-[300px]"><SelectValue placeholder="Select Account" /></SelectTrigger>
          <SelectContent>
            {(glAccounts?.accounts || []).map(a => (
              <SelectItem key={a.id} value={a.code ?? ""}>{a.code} - {a.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input type="date" className="w-40" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
        <Input type="date" className="w-40" value={toDate} onChange={(e) => setToDate(e.target.value)} />
      </div>

      {!accountCode ? (
        <div className="py-12 text-center border rounded-md border-dashed text-muted-foreground">
          Select an account to view movements
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Journal Ref</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Debit</TableHead>
                <TableHead className="text-right">Credit</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={7} className="text-center py-8">Loading ledger...</TableCell></TableRow>
              ) : !data?.data?.length ? (
                <TableRow><TableCell colSpan={7} className="text-center py-8">No movements found</TableCell></TableRow>
              ) : (
                (data.data as unknown as AccountMovement[]).map((m, i) => (
                  <TableRow key={i}>
                    <TableCell>{fmtDate(m.postedAt || m.createdAt)}</TableCell>
                    <TableCell className="font-mono">{m.postingCode}</TableCell>
                    <TableCell className="capitalize text-muted-foreground">{m.entityType?.replace("_", " ") || "Manual"}</TableCell>
                    <TableCell>{m.description}</TableCell>
                    <TableCell className="text-right font-mono">{m.debit ? fmt(m.debit) : ""}</TableCell>
                    <TableCell className="text-right font-mono">{m.credit ? fmt(m.credit) : ""}</TableCell>
                    <TableCell className="text-right font-mono font-medium">{fmt(Math.abs(m.balance))} {m.balance >= 0 ? "DR" : "CR"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ── Chart of Accounts ─────────────────────────────────────────────────────────

const GL_ACCOUNT_TYPES: CreateGlAccountBody["accountType"][] = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
];

const TYPE_BADGE: Record<string, string> = {
  asset: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  liability: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  equity: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
  revenue: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  expense: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
};

interface GlAccountFormValues {
  code: string;
  name: string;
  accountType: CreateGlAccountBody["accountType"];
  isActive: boolean;
}

function GlAccountModal({
  open,
  onOpenChange,
  account,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  account?: MasterGlAccount;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const create = useCreateGlAccount();
  const update = useUpdateGlAccount();
  const isEdit = !!account?.id;

  const { register, control, handleSubmit, reset, formState: { errors } } = useForm<GlAccountFormValues>({
    defaultValues: { code: "", name: "", accountType: "asset", isActive: true },
  });

  useEffect(() => {
    if (open) {
      reset({
        code: account?.code ?? "",
        name: account?.name ?? "",
        accountType: (account?.accountType as CreateGlAccountBody["accountType"]) ?? "asset",
        isActive: account?.isActive ?? true,
      });
    }
  }, [open, account, reset]);

  const onSubmit = handleSubmit(async (vals) => {
    try {
      if (isEdit && account?.id) {
        await update.mutateAsync({ id: account.id, data: vals });
        toast({ title: "GL account updated" });
      } else {
        await create.mutateAsync({ data: vals });
        toast({ title: "GL account created" });
      }
      onSuccess();
      onOpenChange(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "An unexpected error occurred";
      toast({ title: "Error", description: msg, variant: "destructive" });
    }
  });

  const isPending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit GL Account" : "New GL Account"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Update this account in your chart of accounts." : "Add a new account to your chart of accounts."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Code <span className="text-destructive">*</span></Label>
              <Input {...register("code", { required: true })} placeholder="1000" />
              {errors.code && <p className="text-xs text-destructive">Required</p>}
            </div>
            <div className="space-y-1.5">
              <Label>Account Type <span className="text-destructive">*</span></Label>
              <Controller
                control={control}
                name="accountType"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {GL_ACCOUNT_TYPES.map((t) => (
                        <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Name <span className="text-destructive">*</span></Label>
            <Input {...register("name", { required: true })} placeholder="Cash and Cash Equivalents" />
            {errors.name && <p className="text-xs text-destructive">Required</p>}
          </div>
          <div className="flex items-center gap-2 pt-2">
            <Controller
              control={control}
              name="isActive"
              render={({ field }) => (
                <Switch checked={field.value} onCheckedChange={field.onChange} id="gl-active" />
              )}
            />
            <Label htmlFor="gl-active">Active</Label>
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

const VALID_ACCOUNT_TYPES = new Set(["asset", "liability", "equity", "revenue", "expense"]);

function GlAccountCsvImportDialog({ open, onOpenChange, onSuccess }: {
  open: boolean; onOpenChange: (v: boolean) => void; onSuccess: () => void;
}) {
  const { toast } = useToast();
  const importM = useImportGlAccounts();
  const fileRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<BulkImportResult | null>(null);
  const [isParsing, setIsParsing] = useState(false);

  const getCol = (row: Record<string, string>, ...keys: string[]): string | undefined => {
    for (const k of keys) { const v = row[k]?.trim(); if (v) return v; }
    return undefined;
  };

  const toBool = (v: string | undefined, fallback: boolean): boolean => {
    if (v === undefined) return fallback;
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "y", "active"].includes(s)) return true;
    if (["false", "0", "no", "n", "inactive"].includes(s)) return false;
    return fallback;
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsParsing(true);
    setResult(null);
    try {
      const parsed = await new Promise<Papa.ParseResult<Record<string, string>>>((resolve) => {
        Papa.parse<Record<string, string>>(file, {
          header: true,
          skipEmptyLines: true,
          transformHeader: (h) => h.trim().replace(/^\uFEFF/, ""),
          complete: resolve,
        });
      });

      if (parsed.errors.length > 0 && parsed.data.length === 0) {
        toast({ title: "CSV parse error", description: parsed.errors[0]?.message, variant: "destructive" });
        return;
      }

      const clientErrors: { row: number; code: string; error: string }[] = [];
      const accounts: Array<{ code: string; name: string; accountType: "asset" | "liability" | "equity" | "revenue" | "expense"; isActive?: boolean }> = [];

      parsed.data.forEach((r, idx) => {
        const rowNum = idx + 2; // header is row 1
        const code = getCol(r, "code", "Code") ?? "";
        const name = getCol(r, "name", "Name") ?? "";
        const rawType = (getCol(r, "accountType", "account_type", "type") ?? "").toLowerCase();
        if (!code) { clientErrors.push({ row: rowNum, code, error: "Missing code" }); return; }
        if (!name) { clientErrors.push({ row: rowNum, code, error: "Missing name" }); return; }
        if (!VALID_ACCOUNT_TYPES.has(rawType)) {
          clientErrors.push({ row: rowNum, code, error: `Invalid accountType "${rawType}" (expected asset, liability, equity, revenue, or expense)` });
          return;
        }
        accounts.push({
          code,
          name,
          accountType: rawType as "asset" | "liability" | "equity" | "revenue" | "expense",
          isActive: toBool(getCol(r, "isActive", "is_active", "active"), true),
        });
      });

      if (!accounts.length) {
        setResult({ created: 0, updated: 0, errors: clientErrors });
        toast({ title: "No valid rows found", description: "Ensure the CSV has 'code', 'name', and 'accountType' columns.", variant: "destructive" });
        return;
      }

      const res = await importM.mutateAsync({ data: { accounts } });
      const merged: BulkImportResult = {
        created: res.created ?? 0,
        updated: res.updated ?? 0,
        errors: [...clientErrors, ...(res.errors ?? [])],
      };
      setResult(merged);
      const errCount = merged.errors?.length ?? 0;
      toast({ title: `Import complete: ${merged.created} created, ${merged.updated} updated${errCount ? `, ${errCount} errors` : ""}` });
      onSuccess();
    } catch (err: unknown) {
      toast({ title: "Import failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setIsParsing(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleClose = () => { setResult(null); onOpenChange(false); };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Import GL Accounts from CSV</DialogTitle>
          <DialogDescription>
            Upload a CSV with columns: <code className="text-xs bg-muted px-1 rounded">code, name, accountType, isActive</code>.
            Existing accounts (matched by code) will be updated.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleFile} />
          <Button variant="outline" className="w-full" onClick={() => fileRef.current?.click()} disabled={isParsing || importM.isPending}>
            <Upload className="h-4 w-4 mr-2" />
            {isParsing || importM.isPending ? "Processing…" : "Choose CSV file"}
          </Button>
          {result && (
            <div className="rounded-md border p-3 text-sm space-y-2">
              <div className="font-medium">Results</div>
              <div className="text-muted-foreground">Created: <span className="text-foreground font-medium">{result.created}</span></div>
              <div className="text-muted-foreground">Updated: <span className="text-foreground font-medium">{result.updated}</span></div>
              {result.errors && result.errors.length > 0 && (
                <div className="space-y-1">
                  <div className="text-destructive font-medium">Errors: {result.errors.length} row(s) failed</div>
                  <div className="max-h-40 overflow-y-auto text-xs space-y-0.5 border rounded p-2 bg-muted/30">
                    {result.errors.slice(0, 50).map((e, i) => (
                      <div key={i}><span className="font-mono">Row {e.row}{e.code ? ` (${e.code})` : ""}:</span> {e.error}</div>
                    ))}
                    {result.errors.length > 50 && (
                      <div className="text-muted-foreground italic">…and {result.errors.length - 50} more</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChartOfAccountsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [activeFilter, setActiveFilter] = useState<"active" | "all">("active");
  const [page, setPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<MasterGlAccount | undefined>();
  const update = useUpdateGlAccount();

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => { setPage(1); }, [typeFilter, activeFilter]);

  const limit = 25;
  const params = {
    q: debouncedSearch || undefined,
    accountType: typeFilter !== "all" ? typeFilter : undefined,
    activeOnly: activeFilter === "active" ? "true" : "false",
    page,
    limit,
    sort: "code",
    dir: "asc" as const,
  };

  const { data, isLoading, isFetching } = useListGlAccounts(params);
  const accounts = data?.accounts ?? [];
  const hasMore = data?.hasMore ?? false;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: getListGlAccountsQueryKey() });
  };

  const handleToggleActive = async (account: MasterGlAccount) => {
    if (!account.id) return;
    const next = !account.isActive;
    try {
      await update.mutateAsync({ id: account.id, data: { isActive: next } as Partial<CreateGlAccountBody> as CreateGlAccountBody });
      toast({ title: next ? "Account reactivated" : "Account deactivated" });
      refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "An unexpected error occurred";
      toast({ title: "Error", description: msg, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between gap-2 flex-wrap">
        <div className="flex gap-2 flex-wrap">
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search code or name…"
              className="pl-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {GL_ACCOUNT_TYPES.map((t) => (
                <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={activeFilter} onValueChange={(v) => setActiveFilter(v as "active" | "all")}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active only</SelectItem>
              <SelectItem value="all">All accounts</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            asChild
            title="Download a sample CSV with a standard chart of accounts"
          >
            <a
              href={`${import.meta.env.BASE_URL}gl-accounts-sample.csv`}
              download="gl-accounts-sample.csv"
            >
              <Download className="h-4 w-4 mr-2" />Download sample CSV
            </a>
          </Button>
          <Button
            variant="outline"
            onClick={() => setImportOpen(true)}
            title="Import GL accounts from a CSV file"
          >
            <Upload className="h-4 w-4 mr-2" />Import CSV
          </Button>
          <Button onClick={() => { setEditAccount(undefined); setModalOpen(true); }}>
            <Plus className="h-4 w-4 mr-2" />New Account
          </Button>
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="w-32">Type</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-32 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8">Loading accounts…</TableCell></TableRow>
            ) : accounts.length === 0 ? (
              <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No GL accounts found</TableCell></TableRow>
            ) : accounts.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-mono font-medium">{a.code}</TableCell>
                <TableCell>{a.name}</TableCell>
                <TableCell>
                  <Badge variant="secondary" className={`capitalize ${TYPE_BADGE[a.accountType ?? ""] ?? ""}`}>
                    {a.accountType}
                  </Badge>
                </TableCell>
                <TableCell>
                  {a.isActive ? (
                    <Badge variant="default" className="bg-green-100 text-green-800 hover:bg-green-100 dark:bg-green-900/30 dark:text-green-400">Active</Badge>
                  ) : (
                    <Badge variant="secondary">Inactive</Badge>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Edit"
                      onClick={() => { setEditAccount(a); setModalOpen(true); }}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title={a.isActive ? "Deactivate" : "Reactivate"}
                      onClick={() => handleToggleActive(a)}
                      disabled={update.isPending}
                    >
                      <Power className={`h-4 w-4 ${a.isActive ? "text-destructive" : "text-emerald-600"}`} />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <div>
          Page {page}{isFetching ? " — loading…" : ""}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1 || isFetching}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => p + 1)}
            disabled={!hasMore || isFetching}
          >
            Next
          </Button>
        </div>
      </div>

      <GlAccountModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        account={editAccount}
        onSuccess={refresh}
      />

      <GlAccountCsvImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onSuccess={refresh}
      />
    </div>
  );
}

export default function Finance() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Finance</h2>
        <p className="text-muted-foreground">Manage general ledger, AR/AP, and reporting.</p>
      </div>

      <Tabs defaultValue="journals" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="journals">Journal Ledger</TabsTrigger>
          <TabsTrigger value="trial-balance">Trial Balance</TabsTrigger>
          <TabsTrigger value="account-ledger">Account Ledger</TabsTrigger>
          <TabsTrigger value="chart-of-accounts">Chart of Accounts</TabsTrigger>
        </TabsList>
        
        <TabsContent value="journals">
          <JournalTab />
        </TabsContent>
        
        <TabsContent value="trial-balance">
          <TrialBalanceTab />
        </TabsContent>

        <TabsContent value="account-ledger">
          <AccountLedgerTab />
        </TabsContent>

        <TabsContent value="chart-of-accounts">
          <ChartOfAccountsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
