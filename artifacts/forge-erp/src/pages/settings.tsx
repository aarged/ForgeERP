import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useUser } from "@clerk/react";
import { MoreHorizontal, RefreshCw, UserPlus } from "lucide-react";
import {
  useGetCurrentUser,
  useUpdateCurrentUser,
  getGetCurrentUserQueryKey,
  useGetTenantMembers,
  useCreateTenantInvite,
  useUpdateTenantMember,
  useResendTenantInvite,
  useRevokeTenantInvite,
  getGetTenantMembersQueryKey,
} from "@workspace/api-client-react";
import type {
  TenantMember,
  CreateTenantInviteBodyRole,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
import { IntegrationsPanel } from "@/components/settings/integrations-panel";

// ── Profile form ─────────────────────────────────────────────────────────────

const profileSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
});
type ProfileFormValues = z.infer<typeof profileSchema>;

function ProfilePanel() {
  const { toast } = useToast();
  const { data: currentUser, isLoading } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });

  const updateProfile = useUpdateCurrentUser({
    mutation: {
      onSuccess: (data) => {
        toast({ title: "Profile updated successfully" });
        queryClient.setQueryData(getGetCurrentUserQueryKey(), data);
      },
      onError: () => {
        toast({ title: "Failed to update profile", variant: "destructive" });
      },
    },
  });

  const form = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { firstName: "", lastName: "" },
  });

  useEffect(() => {
    if (currentUser) {
      form.reset({
        firstName: currentUser.firstName || "",
        lastName: currentUser.lastName || "",
      });
    }
  }, [currentUser, form]);

  function onSubmit(data: ProfileFormValues) {
    updateProfile.mutate({ data });
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-24" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>Update your personal information.</CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="firstName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>First Name</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="John"
                        {...field}
                        data-testid="input-first-name"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="lastName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Last Name</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Doe"
                        {...field}
                        data-testid="input-last-name"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium leading-none">Email</label>
              <Input
                value={currentUser?.email || ""}
                disabled
                readOnly
                className="bg-muted"
              />
              <p className="text-xs text-muted-foreground">
                Your email address is managed by your identity provider.
              </p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium leading-none">Role</label>
              <Input
                value={currentUser?.role || "Viewer"}
                disabled
                readOnly
                className="bg-muted capitalize"
              />
            </div>
            <Button
              type="submit"
              disabled={updateProfile.isPending}
              data-testid="button-save-profile"
            >
              {updateProfile.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

// ── Members panel ────────────────────────────────────────────────────────────

const ROLE_OPTIONS: Array<{ value: CreateTenantInviteBodyRole; label: string }> = [
  { value: "tenant_admin", label: "Tenant Admin" },
  { value: "purchaser", label: "Purchaser" },
  { value: "warehouse", label: "Warehouse" },
  { value: "approver", label: "Approver" },
  { value: "accountant", label: "Accountant" },
  { value: "viewer", label: "Viewer" },
];

function roleLabel(role: string): string {
  return ROLE_OPTIONS.find((r) => r.value === role)?.label ?? role;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

const inviteSchema = z.object({
  email: z.string().email("Enter a valid email"),
  role: z.enum([
    "tenant_admin",
    "purchaser",
    "warehouse",
    "approver",
    "accountant",
    "viewer",
  ]),
});
type InviteFormValues = z.infer<typeof inviteSchema>;

function InviteDialog({ onInvited }: { onInvited: () => void }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  const form = useForm<InviteFormValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: "", role: "viewer" },
  });

  const createInvite = useCreateTenantInvite({
    mutation: {
      onSuccess: (data) => {
        if (data.delivered) {
          toast({ title: `Invitation sent to ${data.email}` });
        } else {
          toast({
            title: "Invite created but email failed to send",
            description: data.reason ?? "You can resend it from the list.",
            variant: "destructive",
          });
        }
        form.reset({ email: "", role: "viewer" });
        setOpen(false);
        onInvited();
      },
      onError: (err: unknown) => {
        const message =
          err instanceof Error ? err.message : "Failed to send invite";
        toast({ title: message, variant: "destructive" });
      },
    },
  });

  function onSubmit(data: InviteFormValues) {
    createInvite.mutate({ data });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button data-testid="button-invite-member">
          <UserPlus className="mr-2 h-4 w-4" />
          Invite member
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite a new member</DialogTitle>
          <DialogDescription>
            We&apos;ll email them a sign-up link. They&apos;ll join your
            workspace once they accept.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
            id="invite-form"
          >
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      placeholder="teammate@example.com"
                      autoComplete="email"
                      {...field}
                      data-testid="input-invite-email"
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
                      <SelectTrigger data-testid="select-invite-role">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {ROLE_OPTIONS.map((r) => (
                        <SelectItem key={r.value} value={r.value}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={createInvite.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="invite-form"
            disabled={createInvite.isPending}
            data-testid="button-send-invite"
          >
            {createInvite.isPending ? "Sending..." : "Send invite"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MembersPanel() {
  const { toast } = useToast();
  const { user } = useUser();
  const currentClerkId = user?.id;

  const membersKey = getGetTenantMembersQueryKey();
  const {
    data: members,
    isLoading,
    refetch,
  } = useGetTenantMembers({
    query: { queryKey: membersKey },
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: membersKey });
  };

  const updateMember = useUpdateTenantMember({
    mutation: {
      onSuccess: () => {
        refresh();
      },
      onError: (err: unknown) => {
        const message =
          err instanceof Error ? err.message : "Failed to update member";
        toast({ title: message, variant: "destructive" });
      },
    },
  });

  const resendInvite = useResendTenantInvite({
    mutation: {
      onSuccess: (data) => {
        if (data.delivered) {
          toast({ title: `Invitation resent to ${data.email}` });
        } else {
          toast({
            title: "Failed to resend invite",
            description: data.reason ?? undefined,
            variant: "destructive",
          });
        }
        refresh();
      },
      onError: (err: unknown) => {
        const message =
          err instanceof Error ? err.message : "Failed to resend invite";
        toast({ title: message, variant: "destructive" });
      },
    },
  });

  const revokeInvite = useRevokeTenantInvite({
    mutation: {
      onSuccess: () => {
        toast({ title: "Invitation revoked" });
        refresh();
      },
      onError: (err: unknown) => {
        const message =
          err instanceof Error ? err.message : "Failed to revoke invite";
        toast({ title: message, variant: "destructive" });
      },
    },
  });

  const sortedMembers = useMemo(() => {
    if (!members) return [] as TenantMember[];
    // Sort: active first (admins on top), then pending, then inactive
    const statusRank: Record<string, number> = {
      active: 0,
      pending: 1,
      inactive: 2,
    };
    return [...members].sort((a, b) => {
      const r = statusRank[a.status] - statusRank[b.status];
      if (r !== 0) return r;
      if (a.role === "tenant_admin" && b.role !== "tenant_admin") return -1;
      if (b.role === "tenant_admin" && a.role !== "tenant_admin") return 1;
      return a.email.localeCompare(b.email);
    });
  }, [members]);

  const [confirmRevoke, setConfirmRevoke] = useState<TenantMember | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState<TenantMember | null>(
    null,
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            Manage who can access this workspace and their permissions.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => refetch()}
            title="Refresh"
            aria-label="Refresh"
            data-testid="button-refresh-members"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <InviteDialog onInvited={refresh} />
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : sortedMembers.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No members yet. Invite your first teammate to get started.
          </div>
        ) : (
          <div className="rounded-md border">
            <Table data-testid="table-members">
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="w-12 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedMembers.map((m) => {
                  const isSelf = m.clerkId === currentClerkId;
                  const isPending = m.status === "pending";
                  const fullName = [m.firstName, m.lastName]
                    .filter(Boolean)
                    .join(" ");
                  const isUpdatingThis =
                    updateMember.isPending &&
                    updateMember.variables?.membershipId === m.id;
                  return (
                    <TableRow
                      key={m.id}
                      data-testid={`row-member-${m.id}`}
                      className={
                        m.status === "inactive" ? "opacity-60" : undefined
                      }
                    >
                      <TableCell>
                        <div className="flex flex-col">
                          {fullName && (
                            <span className="font-medium">{fullName}</span>
                          )}
                          <span
                            className={
                              fullName
                                ? "text-xs text-muted-foreground"
                                : "font-medium"
                            }
                          >
                            {m.email}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        {isPending || isSelf ? (
                          <span className="text-sm">{roleLabel(m.role)}</span>
                        ) : (
                          <Select
                            value={m.role}
                            onValueChange={(value) => {
                              if (value === m.role) return;
                              updateMember.mutate({
                                membershipId: m.id,
                                data: {
                                  role: value as CreateTenantInviteBodyRole,
                                },
                              });
                            }}
                            disabled={isUpdatingThis || m.role === "global_admin"}
                          >
                            <SelectTrigger
                              className="w-36 h-8"
                              data-testid={`select-role-${m.id}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ROLE_OPTIONS.map((r) => (
                                <SelectItem key={r.value} value={r.value}>
                                  {r.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </TableCell>
                      <TableCell>
                        {m.status === "active" && (
                          <Badge variant="default" data-testid={`status-${m.id}`}>
                            Active
                          </Badge>
                        )}
                        {m.status === "pending" && (
                          <Badge
                            variant="secondary"
                            data-testid={`status-${m.id}`}
                          >
                            Pending
                          </Badge>
                        )}
                        {m.status === "inactive" && (
                          <Badge
                            variant="outline"
                            data-testid={`status-${m.id}`}
                          >
                            Deactivated
                          </Badge>
                        )}
                        {isSelf && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            (you)
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDate(m.joinedAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              disabled={isSelf || m.role === "global_admin"}
                              data-testid={`button-actions-${m.id}`}
                            >
                              <MoreHorizontal className="h-4 w-4" />
                              <span className="sr-only">Actions</span>
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuLabel>Manage</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {isPending && (
                              <>
                                <DropdownMenuItem
                                  onClick={() =>
                                    resendInvite.mutate({ membershipId: m.id })
                                  }
                                  data-testid={`action-resend-${m.id}`}
                                >
                                  Resend invite
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => setConfirmRevoke(m)}
                                  data-testid={`action-revoke-${m.id}`}
                                >
                                  Revoke invite
                                </DropdownMenuItem>
                              </>
                            )}
                            {!isPending && m.isActive && (
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => setConfirmDeactivate(m)}
                                data-testid={`action-deactivate-${m.id}`}
                              >
                                Deactivate
                              </DropdownMenuItem>
                            )}
                            {!isPending && !m.isActive && (
                              <DropdownMenuItem
                                onClick={() =>
                                  updateMember.mutate({
                                    membershipId: m.id,
                                    data: { isActive: true },
                                  })
                                }
                                data-testid={`action-reactivate-${m.id}`}
                              >
                                Reactivate
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <AlertDialog
        open={confirmRevoke !== null}
        onOpenChange={(open) => !open && setConfirmRevoke(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke invitation?</AlertDialogTitle>
            <AlertDialogDescription>
              This will cancel the pending invitation for{" "}
              <span className="font-medium">{confirmRevoke?.email}</span>. They
              will no longer be able to accept it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmRevoke) {
                  revokeInvite.mutate({ membershipId: confirmRevoke.id });
                }
                setConfirmRevoke(null);
              }}
              data-testid="confirm-revoke"
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmDeactivate !== null}
        onOpenChange={(open) => !open && setConfirmDeactivate(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate member?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium">{confirmDeactivate?.email}</span>{" "}
              will lose access to this workspace immediately. You can reactivate
              them at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDeactivate) {
                  updateMember.mutate({
                    membershipId: confirmDeactivate.id,
                    data: { isActive: false },
                  });
                }
                setConfirmDeactivate(null);
              }}
              data-testid="confirm-deactivate"
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

// ── Settings page ────────────────────────────────────────────────────────────

export default function Settings() {
  const { data: currentUser } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });

  const role = currentUser?.role ?? "viewer";
  const canManageMembers = role === "tenant_admin" || role === "global_admin";

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Settings</h2>
        <p className="text-muted-foreground">
          Manage your account and workspace.
        </p>
      </div>

      <Tabs defaultValue="profile" className="space-y-4">
        <TabsList>
          <TabsTrigger value="profile" data-testid="tab-profile">
            Profile
          </TabsTrigger>
          {canManageMembers && (
            <TabsTrigger value="members" data-testid="tab-members">
              Members
            </TabsTrigger>
          )}
          {canManageMembers && (
            <TabsTrigger value="integrations" data-testid="tab-integrations">
              Integrations
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="profile">
          <ProfilePanel />
        </TabsContent>

        {canManageMembers && (
          <TabsContent value="members">
            <MembersPanel />
          </TabsContent>
        )}

        {canManageMembers && (
          <TabsContent value="integrations">
            <IntegrationsPanel />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
