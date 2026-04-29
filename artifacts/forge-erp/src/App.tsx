import { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Switch, Route, Redirect, useLocation, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";

import { useGetCurrentUser, getGetCurrentUserQueryKey } from "@workspace/api-client-react";
import { AppShell } from "@/components/layout/app-shell";
import LandingPage from "@/pages/landing";
import PendingPage from "@/pages/pending";
import OnboardingPage from "@/pages/onboarding";
import Dashboard from "@/pages/dashboard";
import Settings from "@/pages/settings";
import Procurement from "@/pages/procurement";
import Sales from "@/pages/sales";
import Inventory from "@/pages/inventory";
import Reports from "@/pages/reports";
import SuperAdmin from "@/pages/super-admin";
import MasterData from "@/pages/master-data";
import NotFound from "@/pages/not-found";

export const queryClient = new QueryClient();

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(212, 100%, 48%)",
    colorForeground: "hsl(222.2, 84%, 4.9%)",
    colorMutedForeground: "hsl(215.4, 16.3%, 46.9%)",
    colorDanger: "hsl(0, 84.2%, 60.2%)",
    colorBackground: "hsl(0, 0%, 100%)",
    colorInput: "hsl(214.3, 31.8%, 91.4%)",
    colorInputForeground: "hsl(222.2, 84%, 4.9%)",
    colorNeutral: "hsl(214.3, 31.8%, 91.4%)",
    fontFamily: "'Inter', sans-serif",
    borderRadius: "0.3rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-white dark:bg-zinc-950 rounded-2xl w-[440px] max-w-full overflow-hidden border border-border shadow-xl",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-foreground",
    headerSubtitle: "text-muted-foreground",
    socialButtonsBlockButtonText: "text-foreground",
    formFieldLabel: "text-foreground",
    footerActionLink: "text-primary hover:text-primary/90",
    footerActionText: "text-muted-foreground",
    dividerText: "text-muted-foreground",
    identityPreviewEditButton: "text-primary hover:text-primary/90",
    formFieldSuccessText: "text-green-600",
    alertText: "text-destructive-foreground",
    logoBox: "mb-6",
    logoImage: "h-8 object-contain",
    socialButtonsBlockButton: "border-border hover:bg-muted/50",
    formButtonPrimary: "bg-primary text-primary-foreground hover:bg-primary/90",
    formFieldInput: "bg-background border-border text-foreground focus:ring-ring",
    footerAction: "bg-muted/50 py-4 px-8 border-t border-border",
    dividerLine: "bg-border",
    alert: "bg-destructive/10 border border-destructive text-destructive-foreground",
    otpCodeFieldInput: "border-border text-foreground",
    formFieldRow: "mb-4",
    main: "p-8",
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-muted/30 px-4">
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-muted/30 px-4">
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/dashboard" />
      </Show>
      <Show when="signed-out">
        <LandingPage />
      </Show>
    </>
  );
}

/**
 * ProtectedRoute renders the component inside the AppShell for signed-in users
 * who have an active tenant membership. Users who are signed in but have no
 * tenant yet (no `role` returned from /auth/me) are redirected to /onboarding.
 */
function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { data: currentUser, isLoading } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });

  return (
    <>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
      <Show when="signed-in">
        {isLoading ? null : (
          !currentUser?.role ? (
            <Redirect to="/onboarding" />
          ) : (
            <AppShell>
              <Component />
            </AppShell>
          )
        )}
      </Show>
    </>
  );
}

/**
 * OnboardingRoute is for signed-in users who do not yet have a tenant
 * membership. Users that already belong to a tenant are redirected to
 * /dashboard so they don't accidentally re-onboard.
 */
function OnboardingRoute({ component: Component }: { component: React.ComponentType }) {
  const { data: currentUser, isLoading } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });

  return (
    <>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
      <Show when="signed-in">
        {isLoading ? null : currentUser?.role ? (
          <Redirect to="/dashboard" />
        ) : (
          <Component />
        )}
      </Show>
    </>
  );
}

/**
 * SuperAdminRoute only renders for users with the `super_admin` role.
 * All other signed-in users are redirected to /dashboard.
 */
function SuperAdminRoute({ component: Component }: { component: React.ComponentType }) {
  const { data: currentUser, isLoading } = useGetCurrentUser({
    query: { queryKey: getGetCurrentUserQueryKey() },
  });

  return (
    <>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
      <Show when="signed-in">
        {isLoading ? null : (
          currentUser?.role !== "super_admin" ? (
            <Redirect to="/dashboard" />
          ) : (
            <AppShell>
              <Component />
            </AppShell>
          )
        )}
      </Show>
    </>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const queryClient = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        queryClient.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, queryClient]);

  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to access your account",
          },
        },
        signUp: {
          start: {
            title: "Create your account",
            subtitle: "Get started today",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <Switch>
          <Route path="/" component={HomeRedirect} />
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/sign-up/*?" component={SignUpPage} />
          <Route path="/dashboard"><ProtectedRoute component={Dashboard} /></Route>
          <Route path="/settings"><ProtectedRoute component={Settings} /></Route>
          <Route path="/master-data"><ProtectedRoute component={MasterData} /></Route>
          <Route path="/master-data/items/:id">{(params) => <Redirect to={`/master-data?tab=items&id=${params.id}`} />}</Route>
          <Route path="/master-data/suppliers/:id">{(params) => <Redirect to={`/master-data?tab=suppliers&id=${params.id}`} />}</Route>
          <Route path="/master-data/customers/:id">{(params) => <Redirect to={`/master-data?tab=customers&id=${params.id}`} />}</Route>
          <Route path="/master-data/warehouses/:id">{(params) => <Redirect to={`/master-data?tab=warehouses&id=${params.id}`} />}</Route>
          <Route path="/master-data/gl-accounts/:id">{(params) => <Redirect to={`/master-data?tab=gl&id=${params.id}`} />}</Route>
          <Route path="/procurement"><ProtectedRoute component={Procurement} /></Route>
          <Route path="/sales"><ProtectedRoute component={Sales} /></Route>
          <Route path="/inventory"><ProtectedRoute component={Inventory} /></Route>
          <Route path="/reports"><ProtectedRoute component={Reports} /></Route>
          <Route path="/super-admin"><SuperAdminRoute component={SuperAdmin} /></Route>
          <Route path="/onboarding"><OnboardingRoute component={OnboardingPage} /></Route>
          <Route path="/pending"><PendingPage /></Route>
          <Route component={NotFound} />
        </Switch>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

export default function App() {
  return (
    <ThemeProvider defaultTheme="light" storageKey="forge-erp-theme">
      <TooltipProvider>
        <WouterRouter base={basePath}>
          <ClerkProviderWithRoutes />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </ThemeProvider>
  );
}
