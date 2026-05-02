import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Copy, KeyRound, MoreHorizontal, Plus } from "lucide-react";
import {
  useListApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
  getListApiKeysQueryKey,
} from "@workspace/api-client-react";
import type {
  ApiKeySummary,
  CreateApiKeyBodyRole,
  CreateApiKeyResult,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { queryClient } from "@/lib/queryClient";

const createKeySchema = z.object({
  label: z.string().min(1, "Label is required").max(100),
  role: z.enum([
    "tenant_admin",
    "purchaser",
    "warehouse",
    "approver",
    "accountant",
    "viewer",
  ]),
});
type CreateKeyValues = z.infer<typeof createKeySchema>;

const ROLE_OPTIONS: Array<{ value: CreateApiKeyBodyRole; label: string }> = [
  { value: "purchaser", label: "Purchaser (default for integrations)" },
  { value: "viewer", label: "Viewer" },
  { value: "warehouse", label: "Warehouse" },
  { value: "approver", label: "Approver" },
  { value: "accountant", label: "Accountant" },
  { value: "tenant_admin", label: "Tenant admin (full access)" },
];

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function statusBadge(key: ApiKeySummary) {
  if (key.revokedAt) {
    return <Badge variant="destructive" data-testid={`status-${key.id}`}>Revoked</Badge>;
  }
  return <Badge variant="default" data-testid={`status-${key.id}`}>Active</Badge>;
}

export function IntegrationsPanel() {
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [revealedKey, setRevealedKey] = useState<CreateApiKeyResult | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<ApiKeySummary | null>(null);

  const { data: keysResponse, isLoading } = useListApiKeys({
    query: { queryKey: getListApiKeysQueryKey() },
  });

  const form = useForm<CreateKeyValues>({
    resolver: zodResolver(createKeySchema),
    defaultValues: { label: "", role: "purchaser" },
  });

  const createKey = useCreateApiKey({
    mutation: {
      onSuccess: (data) => {
        setCreateOpen(false);
        form.reset({ label: "", role: "purchaser" });
        setRevealedKey(data);
        queryClient.invalidateQueries({ queryKey: getListApiKeysQueryKey() });
      },
      onError: () => {
        toast({ title: "Failed to create API key", variant: "destructive" });
      },
    },
  });

  const revokeKey = useRevokeApiKey({
    mutation: {
      onSuccess: () => {
        toast({ title: "API key revoked" });
        queryClient.invalidateQueries({ queryKey: getListApiKeysQueryKey() });
      },
      onError: () => {
        toast({ title: "Failed to revoke key", variant: "destructive" });
      },
    },
  });

  const onCreate = (values: CreateKeyValues) => {
    createKey.mutate({ data: values });
  };

  const copyToClipboard = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({ title: `${label} copied to clipboard` });
    } catch {
      toast({ title: `Could not copy ${label.toLowerCase()}`, variant: "destructive" });
    }
  };

  const keys = keysResponse?.data ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            API keys
          </CardTitle>
          <CardDescription>
            Create API keys for external systems (e.g. Cyntric) so they can
            create quotations on your behalf. Keys are revealed only once at
            creation — copy them to your secret store before closing the dialog.
          </CardDescription>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="create-api-key">
              <Plus className="mr-2 h-4 w-4" />
              New key
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>
                Give this key a memorable label and choose the role it should
                act as. The plaintext token will be revealed once.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onCreate)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="label"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Label</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="cyntric-prod"
                          data-testid="api-key-label"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="role"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Role</FormLabel>
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="api-key-role">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {ROLE_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setCreateOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={createKey.isPending}
                    data-testid="submit-api-key"
                  >
                    {createKey.isPending ? "Creating…" : "Create key"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : keys.length === 0 ? (
          <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
            No API keys yet. Create one to let an external system push data
            into Forge.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="w-10"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => (
                <TableRow key={key.id} data-testid={`api-key-row-${key.id}`}>
                  <TableCell className="font-medium">{key.label}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {key.prefix}…
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{key.role}</Badge>
                  </TableCell>
                  <TableCell>{statusBadge(key)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(key.createdAt)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(key.lastUsedAt)}
                  </TableCell>
                  <TableCell>
                    {!key.revokedAt && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setConfirmRevoke(key)}
                            data-testid={`revoke-${key.id}`}
                          >
                            Revoke
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {/* One-time reveal dialog — closes only when the user dismisses it. */}
      <Dialog
        open={revealedKey !== null}
        onOpenChange={(open) => {
          if (!open) setRevealedKey(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save your API key</DialogTitle>
            <DialogDescription>
              This is the only time the full token is shown. Copy it now and
              store it securely — Forge only retains a one-way hash.
            </DialogDescription>
          </DialogHeader>
          {revealedKey && (
            <div className="space-y-3">
              <div className="rounded-md border bg-muted/50 p-3">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {revealedKey.label}
                </div>
                <div
                  className="mt-1 break-all font-mono text-sm"
                  data-testid="revealed-key"
                >
                  {revealedKey.plaintextKey}
                </div>
              </div>
              <Button
                variant="outline"
                onClick={() =>
                  copyToClipboard(revealedKey.plaintextKey, "API key")
                }
                data-testid="copy-revealed-key"
              >
                <Copy className="mr-2 h-4 w-4" />
                Copy to clipboard
              </Button>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setRevealedKey(null)}>I've stored it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={confirmRevoke !== null}
        onOpenChange={(open) => !open && setConfirmRevoke(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API key?</AlertDialogTitle>
            <AlertDialogDescription>
              The integration using{" "}
              <span className="font-medium">{confirmRevoke?.label}</span> will
              immediately lose access. This cannot be undone — you'll need to
              create a new key if you want to restore access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmRevoke) {
                  revokeKey.mutate({ id: confirmRevoke.id });
                }
                setConfirmRevoke(null);
              }}
              data-testid="confirm-revoke-key"
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
