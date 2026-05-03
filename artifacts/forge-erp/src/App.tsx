import { useEffect, useRef } from "react";
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useAuth } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Switch, Route, Redirect, useLocation, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/components/theme-provider";

import {
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
  setAuthTokenGetter,
} from "@workspace/api-client-react";
import { AppShell } from "@/components/layout/app-shell";
import LandingPage from "@/pages/landing";
import PendingPage from "@/pages/pending";
import OnboardingPage from "@/pages/onboarding";
import Dashboard from "@/pages/dashboard";
import Settings from "@/pages/settings";
import Procurement from "@/pages/procurement";
import Sales from "@/pages/sales";
import Inventory from "@/pages/inventory";
import Finance from "@/pages/finance";
import Reports from "@/pages/reports";
import SuperAdmin from "@/pages/super-admin";
import SuperAdminInvitePage, {
  peekPendingInviteToken,
} from "@/pages/super-admin-invite";
import MasterData from "@/pages/master-data";
import PickerApp from "@/pages/picking/PickerApp";
import DocsPage from "@/pages/docs";
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
  // Invite emails link to /sign-up?email_address=<invitee> so the new user
  // doesn't have to retype the address they were invited under. The lazy
  // claim in /auth/me still matches them by verified email after sign-up.
  const params = new URLSearchParams(window.location.search);
  const invitedEmail =
    params.get("email_address") ??
    params.get("emailAddress") ??
    params.get("email") ??
    undefined;
  const initialValues = invitedEmail ? { emailAddress: invitedEmail } : undefined;
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-muted/30 px-4">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        initialValues={initialValues}
      />
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

/**
 * Wires Clerk's session token into the orval-generated API client so that
 * every API request carries an `Authorization: Bearer <jwt>` header.
 *
 * Why this matters: in development the Clerk session is stored in cookies
 * tagged `SameSite=Lax`. The Replit workspace renders the app inside a
 * cross-site iframe, so those cookies are never sent on /api/* requests
 * and the server returns 401 with `x-clerk-auth-reason: dev-browser-missing`.
 * Passing the JWT explicitly via the Authorization header sidesteps the
 * cookie restriction. @clerk/express's getAuth() accepts both transports.
 */
function ClerkAuthTokenBridge() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const queryClient = useQueryClient();
  const didInvalidateRef = useRef(false);

  useEffect(() => {
    setAuthTokenGetter(async () => {
      try {
        return await getToken();
      } catch {
        return null;
      }
    });
    return () => {
      setAuthTokenGetter(null);
    };
  }, [getToken]);

  // First-time setup OR re-sign-in: invalidate any /auth/me-style queries
  // that may have been kicked off before the token getter was ready
  // (e.g. on a page reload while already signed in).
  useEffect(() => {
    if (isLoaded && isSignedIn && !didInvalidateRef.current) {
      didInvalidateRef.current = true;
      queryClient.invalidateQueries();
    }
    if (!isSignedIn) {
      didInvalidateRef.current = false;
    }
  }, [isLoaded, isSignedIn, queryClient]);

  return null;
}

/**
 * If the user clicked a /super-admin-invite/:token link before signing in,
 * we stash the token in sessionStorage. After Clerk completes the sign-in /
 * sign-up flow they typically land on /dashboard or /onboarding — this
 * watcher routes them back to the invite landing page so the redeem hook
 * can run.
 */
function PendingSuperAdminInviteRedirect() {
  const [location, setLocation] = useLocation();
  const { isLoaded, isSignedIn } = useAuth();

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    if (location.startsWith("/super-admin-invite/")) return;
    if (location.startsWith("/sign-in") || location.startsWith("/sign-up"))
      return;
    const token = peekPendingInviteToken();
    if (token) {
      setLocation(`/super-admin-invite/${token}`);
    }
  }, [isLoaded, isSignedIn, location, setLocation]);

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
        <ClerkAuthTokenBridge />
        <ClerkQueryClientCacheInvalidator />
        <PendingSuperAdminInviteRedirect />
        <Switch>
          <Route path="/" component={HomeRedirect} />
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/sign-up/*?" component={SignUpPage} />
          <Route path="/dashboard"><ProtectedRoute component={Dashboard} /></Route>
          <Route path="/settings"><ProtectedRoute component={Settings} /></Route>
          <Route path="/master-data"><ProtectedRoute component={MasterData} /></Route>
          <Route path="/master-data/items/:id">{(params) => <Redirect to={`/master-data?tab=items&code=${params.id}`} />}</Route>
          <Route path="/master-data/suppliers/:id">{(params) => <Redirect to={`/master-data?tab=suppliers&code=${params.id}`} />}</Route>
          <Route path="/master-data/customers/:id">{(params) => <Redirect to={`/master-data?tab=customers&code=${params.id}`} />}</Route>
          <Route path="/master-data/warehouses/:id">{(params) => <Redirect to={`/master-data?tab=warehouses&code=${params.id}`} />}</Route>
          <Route path="/master-data/gl-accounts/:id">{(params) => <Redirect to={`/master-data?tab=gl-accounts&id=${params.id}`} />}</Route>
          <Route path="/procurement"><ProtectedRoute component={Procurement} /></Route>
          <Route path="/sales"><ProtectedRoute component={Sales} /></Route>
          <Route path="/inventory"><ProtectedRoute component={Inventory} /></Route>
          <Route path="/finance"><ProtectedRoute component={Finance} /></Route>
          <Route path="/reports"><ProtectedRoute component={Reports} /></Route>
          <Route path="/super-admin"><SuperAdminRoute component={SuperAdmin} /></Route>
          <Route path="/super-admin-invite/:token" component={SuperAdminInvitePage} />
          <Route path="/docs"><ProtectedRoute component={DocsPage} /></Route>
          <Route path="/docs/:slug"><ProtectedRoute component={DocsPage} /></Route>
          <Route path="/picking" component={PickerApp} />
          <Route path="/picking/slip/:id" component={PickerApp} />
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
