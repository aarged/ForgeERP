import { useUser } from "@clerk/react";
import { Link, useLocation } from "wouter";
import {
  BarChart3,
  ChevronDown,
  Command,
  Database,
  LayoutDashboard,
  LogOut,
  Moon,
  PackageSearch,
  Receipt,
  Search,
  Settings,
  ShieldAlert,
  ShoppingCart,
  Sun,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTheme } from "@/components/theme-provider";
import { useClerk } from "@clerk/react";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { getGetCurrentUserQueryKey } from "@workspace/api-client-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";

const COMMAND_ITEMS = [
  { label: "Go to Dashboard", href: "/dashboard" },
  { label: "Go to Master Data", href: "/master-data" },
  { label: "Go to Procurement", href: "/procurement" },
  { label: "Go to Sales", href: "/sales" },
  { label: "Go to Inventory", href: "/inventory" },
  { label: "Go to Reports", href: "/reports" },
  { label: "Go to Settings", href: "/settings" },
];

function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? COMMAND_ITEMS.filter((item) =>
        item.label.toLowerCase().includes(query.toLowerCase()),
      )
    : COMMAND_ITEMS;

  function navigate(href: string) {
    setLocation(href);
    setQuery("");
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md p-0 overflow-hidden" aria-describedby={undefined}>
        <DialogHeader className="sr-only">
          <DialogTitle>Command Palette</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <Search className="size-4 text-muted-foreground shrink-0" />
          <input
            autoFocus
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            placeholder="Search commands…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "Enter" && filtered[0]) navigate(filtered[0].href);
            }}
          />
          <kbd className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded border">
            esc
          </kbd>
        </div>
        <div className="py-2 max-h-72 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No results found.
            </p>
          ) : (
            filtered.map((item) => (
              <button
                key={item.href}
                className="w-full flex items-center gap-3 px-4 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer text-left"
                onClick={() => navigate(item.href)}
              >
                {item.label}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AppSidebar({
  onOpenCommandPalette,
}: {
  onOpenCommandPalette: () => void;
}) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const { theme, setTheme } = useTheme();
  const [location] = useLocation();

  const { data: currentUser } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });

  const role = currentUser?.role || "viewer";
  const tenantName = currentUser?.tenantName || "Unknown Tenant";

  const navigation = [
    { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard, roles: ["all"] },
    { name: "Master Data", href: "/master-data", icon: Database, roles: ["super_admin", "tenant_admin", "accountant"] },
    { name: "Procurement", href: "/procurement", icon: ShoppingCart, roles: ["super_admin", "tenant_admin", "purchaser", "approver"] },
    { name: "Sales", href: "/sales", icon: Receipt, roles: ["super_admin", "tenant_admin", "approver"] },
    { name: "Inventory", href: "/inventory", icon: PackageSearch, roles: ["super_admin", "tenant_admin", "warehouse"] },
    { name: "Reports", href: "/reports", icon: BarChart3, roles: ["super_admin", "tenant_admin", "accountant", "approver"] },
    { name: "Settings", href: "/settings", icon: Settings, roles: ["all"] },
  ];

  const filteredNavigation = navigation.filter(
    (item) =>
      item.roles.includes("all") ||
      item.roles.includes(role) ||
      role === "super_admin",
  );

  return (
    <Sidebar className="border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <SidebarHeader className="border-b border-sidebar-border p-4">
        <div className="flex items-center gap-2 px-2">
          <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Command className="size-5" />
          </div>
          <div className="flex flex-col gap-0.5 leading-none">
            <span className="font-semibold tracking-tight">Forge ERP</span>
            <span className="text-xs text-muted-foreground">{tenantName}</span>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {filteredNavigation.map((item) => {
                const isActive = location.startsWith(item.href);
                return (
                  <SidebarMenuItem key={item.name}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={item.name}
                    >
                      <Link href={item.href} data-testid={`nav-${item.name.toLowerCase()}`}>
                        <item.icon />
                        <span>{item.name}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
              {role === "super_admin" && (
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip="Super Admin">
                    <Link href="/super-admin" data-testid="nav-super-admin">
                      <ShieldAlert />
                      <span>Super Admin</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-4">
        <div className="flex items-center justify-between gap-2 px-2 mb-2">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            data-testid="button-theme-toggle"
          >
            {theme === "light" ? <Moon className="size-4" /> : <Sun className="size-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            onClick={onOpenCommandPalette}
            title="Command palette (⌘K)"
            data-testid="button-command-palette"
          >
            <Command className="size-4" />
          </Button>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
              data-testid="user-menu-trigger"
            >
              <Avatar className="h-8 w-8 rounded-lg">
                <AvatarImage src={user?.imageUrl} alt={user?.fullName || ""} />
                <AvatarFallback className="rounded-lg">
                  {user?.firstName?.charAt(0)}
                  {user?.lastName?.charAt(0)}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">{user?.fullName}</span>
                <span className="truncate text-xs text-muted-foreground">{role}</span>
              </div>
              <ChevronDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg"
            side="bottom"
            align="end"
            sideOffset={4}
          >
            <DropdownMenuItem
              onClick={() => signOut()}
              className="cursor-pointer"
              data-testid="menu-sign-out"
            >
              <LogOut className="mr-2 size-4" />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [commandOpen, setCommandOpen] = useState(false);

  const openCommandPalette = useCallback(() => setCommandOpen(true), []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <SidebarProvider>
      <AppSidebar onOpenCommandPalette={openCommandPalette} />
      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} />
      <main className="flex-1 flex flex-col min-h-[100dvh] bg-background">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b bg-background px-4 sm:px-6">
          <SidebarTrigger className="-ml-1" />
          <div className="flex-1" />
        </header>
        <div className="flex-1 p-4 sm:p-6 lg:p-8">{children}</div>
      </main>
    </SidebarProvider>
  );
}
