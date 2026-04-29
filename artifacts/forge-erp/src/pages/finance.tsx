import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm, useFieldArray } from "react-hook-form";
import {
  useGetFinanceJournals,
  getGetFinanceJournalsQueryKey,
  usePostFinanceJournals,
  usePostFinanceJournalsIdReverse,
  useGetFinanceTrialBalance,
  getGetFinanceTrialBalanceQueryKey,
  useGetFinanceAccountMovements,
  getGetFinanceAccountMovementsQueryKey,
  useListGlAccounts
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
import { Plus, Search, Eye, Download, Undo2, ChevronDown, ChevronRight, FileText } from "lucide-react";

function fmt(n: any, isCurrency = true) {
  if (n == null) return "—";
  const num = Number(n);
  if (num === 0) return isCurrency ? "$0.00" : "0";
  return new Intl.NumberFormat('en-US', { 
    style: isCurrency ? 'currency' : 'decimal', 
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(num);
}

function fmtDate(s: string) {
  if (!s) return "—";
  return new Date(s).toLocaleDateString();
}

function StatusBadge({ status }: { status: string }) {
  const map: any = {
    posted: "default",
    draft: "secondary",
    reversed: "destructive",
  };
  return <Badge variant={map[status] || "outline"}>{status}</Badge>;
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

  const form = useForm({
    defaultValues: {
      memo: "",
      postedAt: new Date().toISOString().split("T")[0],
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

  async function onSubmit(vals: any) {
    if (!isBalanced) {
      toast({ title: "Journal not balanced", description: "Total debit must equal total credit", variant: "destructive" });
      return;
    }
    try {
      await postMut.mutateAsync({ data: { 
        memo: vals.memo, 
        postingDate: vals.postingDate,
        lines: vals.lines.filter((l: any) => l.accountCode) 
      }});
      toast({ title: "Journal entry posted" });
      setShowCreate(false);
      form.reset();
      qc.invalidateQueries({ queryKey: getGetFinanceJournalsQueryKey({}) });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  }

  async function onReverse(id: number) {
    if (!confirm("Are you sure you want to reverse this journal?")) return;
    try {
      await reverseMut.mutateAsync({ id, data: { memo: "Manual reversal" } });
      toast({ title: "Journal reversed" });
      qc.invalidateQueries({ queryKey: getGetFinanceJournalsQueryKey({}) });
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    }
  }

  const rows = data?.data || [];
  const filtered = rows.filter(r => !search || r.code?.toLowerCase().includes(search.toLowerCase()) || (r as any).memo?.toLowerCase().includes(search.toLowerCase()));

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
        <Button onClick={() => setShowCreate(true)}><Plus className="h-4 w-4 mr-2" />Manual Entry</Button>
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
            ) : filtered.map((r: any) => (
              <React.Fragment key={r.id}>
                <TableRow className={expandedId === r.id ? "bg-muted/50" : ""}>
                  <TableCell>
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}>
                      {expandedId === r.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </Button>
                  </TableCell>
                  <TableCell className="font-mono font-medium">{r.code}</TableCell>
                  <TableCell>{fmtDate(r.postedAt || r.createdAt)}</TableCell>
                  <TableCell>{r.memo}</TableCell>
                  <TableCell className="capitalize text-muted-foreground">{r.entityType?.replace("_", " ") || "Manual"}</TableCell>
                  <TableCell className="text-right font-medium">{fmt(r.totalDebit)}</TableCell>
                  <TableCell><StatusBadge status={r.status} /></TableCell>
                  <TableCell className="text-right">
                    {r.status === "posted" && (
                      <Button variant="ghost" size="sm" title="Reverse" onClick={() => onReverse(r.id)}>
                        <Undo2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
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
                            {(r.lines || []).map((l: any, i: number) => (
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
                <Input type="date" {...form.register("postedAt", { required: true })} />
              </div>
              <div>
                <Label>Memo *</Label>
                <Input {...form.register("memo", { required: true })} placeholder="Reason for journal..." />
              </div>
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
              <TableHead className="text-right">Period Debit</TableHead>
              <TableHead className="text-right">Period Credit</TableHead>
              <TableHead className="text-right">Closing Balance</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8">Loading trial balance...</TableCell></TableRow>
            ) : !data?.accounts?.length ? (
              <TableRow><TableCell colSpan={6} className="text-center py-8">No activity found</TableCell></TableRow>
            ) : (
              <>
                {data.accounts.map((a: any) => (
                  <TableRow key={a.accountId}>
                    <TableCell className="font-mono">{a.accountCode}</TableCell>
                    <TableCell className="font-medium">{a.accountName}</TableCell>
                    <TableCell className="capitalize">{a.accountType?.replace("_", " ")}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(a.periodDebit)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(a.periodCredit)}</TableCell>
                    <TableCell className="text-right font-mono font-medium">{fmt(Math.abs(a.closingBalance))} {a.closingBalance >= 0 ? "DR" : "CR"}</TableCell>
                  </TableRow>
                ))}
                <TableRow className="bg-muted/50 font-bold border-t-2 border-primary">
                  <TableCell colSpan={3} className="text-right">Totals</TableCell>
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
                data.data.map((m: any, i: number) => (
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
      </Tabs>
    </div>
  );
}
