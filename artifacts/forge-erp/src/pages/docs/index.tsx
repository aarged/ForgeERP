import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  type ComponentType,
  type LazyExoticComponent,
} from "react";
import { Link, useRoute, useLocation, Redirect } from "wouter";
import {
  BookOpen,
  LayoutDashboard,
  Database,
  ShoppingCart,
  Receipt,
  PackageSearch,
  Calculator,
  BarChart3,
  Smartphone,
  Shield,
  History,
  type LucideIcon,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { DocsSearch, scrollToDocsSection } from "./DocsSearch";

const OverviewGuide = lazy(() => import("./guides/overview"));
const DashboardGuide = lazy(() => import("./guides/dashboard"));
const MasterDataGuide = lazy(() => import("./guides/master-data"));
const ProcurementGuide = lazy(() => import("./guides/procurement"));
const SalesGuide = lazy(() => import("./guides/sales"));
const InventoryGuide = lazy(() => import("./guides/inventory"));
const FinanceGuide = lazy(() => import("./guides/finance"));
const ReportsGuide = lazy(() => import("./guides/reports"));
const PickingGuide = lazy(() => import("./guides/picking"));
const AdministrationGuide = lazy(() => import("./guides/administration"));
const ChangelogGuide = lazy(() => import("./guides/changelog"));

type GuideEntry = {
  slug: string;
  label: string;
  icon: LucideIcon;
  group: "Getting started" | "Modules" | "Reference";
  Component: LazyExoticComponent<ComponentType>;
};

const GUIDES: GuideEntry[] = [
  {
    slug: "overview",
    label: "Product Overview",
    icon: BookOpen,
    group: "Getting started",
    Component: OverviewGuide,
  },
  {
    slug: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    group: "Modules",
    Component: DashboardGuide,
  },
  {
    slug: "master-data",
    label: "Master Data",
    icon: Database,
    group: "Modules",
    Component: MasterDataGuide,
  },
  {
    slug: "procurement",
    label: "Procurement",
    icon: ShoppingCart,
    group: "Modules",
    Component: ProcurementGuide,
  },
  {
    slug: "sales",
    label: "Sales",
    icon: Receipt,
    group: "Modules",
    Component: SalesGuide,
  },
  {
    slug: "inventory",
    label: "Inventory",
    icon: PackageSearch,
    group: "Modules",
    Component: InventoryGuide,
  },
  {
    slug: "finance",
    label: "Finance",
    icon: Calculator,
    group: "Modules",
    Component: FinanceGuide,
  },
  {
    slug: "reports",
    label: "Reports",
    icon: BarChart3,
    group: "Modules",
    Component: ReportsGuide,
  },
  {
    slug: "picking",
    label: "Mobile Picking PWA",
    icon: Smartphone,
    group: "Modules",
    Component: PickingGuide,
  },
  {
    slug: "administration",
    label: "Administration",
    icon: Shield,
    group: "Modules",
    Component: AdministrationGuide,
  },
  {
    slug: "changelog",
    label: "Changelog",
    icon: History,
    group: "Reference",
    Component: ChangelogGuide,
  },
];

const GROUP_ORDER: GuideEntry["group"][] = [
  "Getting started",
  "Modules",
  "Reference",
];

function DocsTOC({ activeSlug }: { activeSlug: string }) {
  const grouped = useMemo(() => {
    const m: Record<string, GuideEntry[]> = {};
    for (const g of GUIDES) {
      (m[g.group] ??= []).push(g);
    }
    return m;
  }, []);

  return (
    <aside
      className="hidden lg:block w-64 shrink-0 border-r bg-muted/20"
      data-testid="docs-toc"
    >
      <ScrollArea className="h-[calc(100dvh-3.5rem)]">
        <div className="p-4 space-y-6">
          {GROUP_ORDER.map((group) => {
            const items = grouped[group];
            if (!items?.length) return null;
            return (
              <div key={group} className="space-y-1">
                <div className="px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group}
                </div>
                <nav className="flex flex-col gap-0.5">
                  {items.map((item) => {
                    const isActive = item.slug === activeSlug;
                    return (
                      <Link
                        key={item.slug}
                        href={`/docs/${item.slug}`}
                        data-testid={`docs-nav-${item.slug}`}
                        className={cn(
                          "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                          isActive
                            ? "bg-primary/10 text-primary font-medium"
                            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                        )}
                      >
                        <item.icon className="size-4 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    );
                  })}
                </nav>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </aside>
  );
}

function MobileTOC({
  activeSlug,
}: {
  activeSlug: string;
}) {
  const [, setLocation] = useLocation();
  return (
    <div className="lg:hidden border-b p-3" data-testid="docs-mobile-toc">
      <select
        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        value={activeSlug}
        onChange={(e) => setLocation(`/docs/${e.target.value}`)}
        data-testid="docs-mobile-select"
      >
        {GROUP_ORDER.map((group) => {
          const items = GUIDES.filter((g) => g.group === group);
          if (!items.length) return null;
          return (
            <optgroup key={group} label={group}>
              {items.map((g) => (
                <option key={g.slug} value={g.slug}>
                  {g.label}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </div>
  );
}

function GuideSkeleton() {
  return (
    <div className="space-y-4 max-w-3xl">
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
    </div>
  );
}

export default function DocsPage() {
  const [, params] = useRoute<{ slug?: string }>("/docs/:slug?");
  const slug = params?.slug ?? "overview";

  const guide = GUIDES.find((g) => g.slug === slug);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.slice(1);
    if (hash) {
      scrollToDocsSection(hash);
    } else {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
    function onHashChange() {
      const h = window.location.hash.slice(1);
      if (h) scrollToDocsSection(h);
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [slug]);

  if (!guide) {
    return <Redirect to="/docs/overview" />;
  }

  const ActiveGuide = guide.Component;

  return (
    <div
      className="-mx-4 sm:-mx-6 lg:-mx-8 -my-4 sm:-my-6 lg:-my-8 flex flex-col min-h-[calc(100dvh-3.5rem)]"
      data-testid="docs-shell"
    >
      <div
        className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 sticky top-0 z-30"
        data-testid="docs-header"
      >
        <div className="flex items-center gap-3 px-4 sm:px-6 lg:px-8 py-2.5">
          <DocsSearch />
        </div>
      </div>
      <div className="flex flex-1 min-h-0">
        <DocsTOC activeSlug={slug} />
        <div className="flex-1 min-w-0">
          <MobileTOC activeSlug={slug} />
          <div className="px-4 sm:px-6 lg:px-10 py-6 lg:py-10">
            <Suspense fallback={<GuideSkeleton />}>
              <ActiveGuide />
            </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
