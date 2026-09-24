import { LockKeyIcon, WarningIcon } from "@phosphor-icons/react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, Link as RouterLink, Outlet, RouterProvider } from "@tanstack/react-router";
import { forwardRef, lazy, StrictMode, Suspense, useState, type ComponentType, type FormEvent } from "react";
import { createRoot } from "react-dom/client";

import { PermissionDenied, api, errorMessage, sessionQueryKey, Unauthenticated } from "./api";
import { reauthenticateWithPassword, verifySecondFactor, type ReauthResult } from "./auth-client";
import { viewAvailability, type AdminViewDescriptor } from "./registry";
import { CommandIntent, CommandLayer, CommandProvider } from "./shell/commands";
import { AdminProvider, useAdmin, useNow } from "./shell/context";
import { Banner, Button, Empty, Input, KumoPortalProvider, LinkProvider, LayerCard, Loader, SensitiveInput, Sidebar, Toasty, TooltipProvider, type LinkComponentProps } from "./shell/kumo";
import { AdminSidebar, readSidebarOpen, writeSidebarOpen } from "./shell/Sidebar";
import { ThemeProvider, TopBar } from "./shell/TopBar";
import { sanitizeSearch } from "./shell/url-state";
import { AdminError, AdminLoading } from "./shell/ui";
import { adminRegistry } from "./views";
import "./styles.css";

/** Kumo links (sidebar, breadcrumbs, menus) navigate through TanStack Router, never a full reload. */
const RouterBridge = forwardRef<HTMLAnchorElement, LinkComponentProps>(({ href, to, ...rest }, ref) => {
  const target = href ?? to ?? "";
  if (/^(?:[a-z]+:)?\/\//iu.test(target) || target.startsWith("mailto:")) return <a ref={ref} href={target} {...rest} />;
  const [path, query] = target.split("?");
  return <RouterLink ref={ref} to={path as never} {...(query ? { search: Object.fromEntries(new URLSearchParams(query)) as never } : {})} {...(rest as object)} />;
});
RouterBridge.displayName = "RouterBridge";

function SignIn(props: { notice?: string }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"password" | "code">("password");
  const [codeKind, setCodeKind] = useState<"totp" | "backup">("totp");
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const local = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  const done = async (result: ReauthResult) => {
    setWorking(false);
    if (result.ok) { await queryClient.invalidateQueries({ queryKey: sessionQueryKey }); return; }
    if ("needsCode" in result) { setStage("code"); setError(undefined); return; }
    setError(result.error);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setWorking(true);
    // A bare username signs in as <username>@trestle.local; "admin" is the local default operator.
    if (stage === "code") await done(await verifySecondFactor(code, codeKind));
    else await done(await reauthenticateWithPassword(email.includes("@") ? email : `${email.trim()}@trestle.local`, password));
  };
  return <main className="grid min-h-screen place-items-center bg-kumo-canvas px-4">
    <LayerCard className="w-full max-w-sm"><LayerCard.Primary className="p-8">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
        <div><p className="text-xs font-semibold uppercase tracking-wider text-kumo-subtle">Platform admin</p><h1 className="mt-1 text-2xl font-semibold text-kumo-default">Operator sign-in</h1></div>
        <p className="text-sm text-kumo-subtle">Access requires an assigned platform role. Organization and application roles grant no platform authority.</p>
        {props.notice && <Banner variant="alert" size="sm" description={props.notice} />}
        {stage === "password" ? <>
          <Input label="Email or username" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} />
          <SensitiveInput label="Password" autoComplete="current-password" required value={password} onChange={(event: { target: { value: string } }) => setPassword(event.target.value)} />
        </> : <>
          <p className="text-sm text-kumo-default">Enter the {codeKind === "totp" ? "6-digit code from your authenticator app" : "backup code"}.</p>
          <Input label={codeKind === "totp" ? "Authentication code" : "Backup code"} autoFocus autoComplete="one-time-code" inputMode={codeKind === "totp" ? "numeric" : "text"} required value={code} onChange={(event) => setCode(event.target.value)} />
          <Button variant="ghost" size="sm" onClick={() => setCodeKind(codeKind === "totp" ? "backup" : "totp")}>{codeKind === "totp" ? "Use a backup code" : "Use an authenticator code"}</Button>
        </>}
        {error && <Banner variant="error" size="sm" description={error} />}
        <Button type="submit" variant="primary" loading={working}>{stage === "code" ? "Verify" : "Sign in"}</Button>
      </form>
      {local && <Banner className="mt-6" variant="secondary" size="sm" title="Local development only" description="Username admin, password admin. This account is refused outside local." />}
    </LayerCard.Primary></LayerCard>
  </main>;
}

/** Production and staging carry a persistent warning that cannot be mistaken for page content. */
function EnvironmentStrip() {
  const { environment } = useAdmin();
  if (environment === "production") return <Banner variant="error" size="sm" className="rounded-none" icon={<WarningIcon />} title="Production" description="Changes here affect live customers. Every action is audited." />;
  if (environment === "staging") return <Banner variant="alert" size="sm" className="rounded-none" title="Staging" description="Pre-production environment." />;
  return null;
}

/** Persistent while a support session is active; cleared when the server reports it ended. */
function SupportBanner() {
  const { supportSession, session, exitSupportSession } = useAdmin();
  const now = useNow();
  if (!supportSession) return null;
  const remaining = Math.max(0, Date.parse(supportSession.expiresAt) - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return <div role="region" aria-label="Support session" className="sticky top-12 z-10">
    <Banner variant="alert" className="rounded-none" title={`Support session: ${supportSession.organizationName}`}
      description={<span className="flex flex-col gap-2">
        <span className="flex flex-wrap gap-x-4 gap-y-1">
          <span>Profile {supportSession.profile}</span>
          <span>Operator {session.operator.email} (you remain the actor)</span>
          {supportSession.ticket && <span>Ticket {supportSession.ticket}</span>}
          <span>Reason: {supportSession.reason}</span>
          <span className="font-mono" aria-live="off">{minutes}:{String(seconds).padStart(2, "0")} left</span>
        </span>
        {/* Actions wrap with the text so the banner never forces horizontal scrolling on phones. */}
        <span className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => void router.navigate({ to: "/support/sessions" as never, search: { selected: supportSession.id } as never })}>Session and audit</Button>
          <Button size="sm" variant="primary" onClick={() => void exitSupportSession()}>Exit support context</Button>
        </span>
      </span>} />
  </div>;
}

/** Route-level handling: a view the operator cannot use explains why instead of failing on its first request. */
function ViewGuard(props: { view: AdminViewDescriptor; component: ComponentType }) {
  const { navigationContext } = useAdmin();
  const availability = viewAvailability(props.view, navigationContext);
  if (availability.kind === "hidden" && availability.reason === "permission") return <Banner variant="secondary" icon={<LockKeyIcon />} title="Not permitted" description={`Viewing ${props.view.navigation.label} requires the ${props.view.permission} platform permission.`} />;
  if (availability.kind === "hidden") return <Empty title={`${props.view.navigation.label} is not enabled`} description="Declare this capability in .trestle/project.yaml to enable it." />;
  if (availability.kind === "unconfigured") return <Empty title={`${props.view.navigation.label} is not configured`} description={availability.message} commandLine={availability.repair} />;
  const View = props.component;
  return <Suspense fallback={<AdminLoading label={`Loading ${props.view.navigation.label}`} />}><View /></Suspense>;
}

function Layout() {
  return <div className="isolate min-h-screen bg-kumo-canvas text-kumo-default">
      <Sidebar.Provider defaultOpen={readSidebarOpen()} onOpenChange={writeSidebarOpen} collapsible="icon">
        <AdminSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <EnvironmentStrip />
          <TopBar />
          <SupportBanner />
          <main id="admin-main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 lg:px-8"><CommandIntent /><Outlet /></main>
        </div>
        <CommandLayer />
      </Sidebar.Provider>
    </div>;
}

const rootRoute = createRootRoute({ component: Layout });
const viewRoutes = adminRegistry.views.map((view) => {
  const component = lazy(view.component);
  return createRoute({ getParentRoute: () => rootRoute, path: view.path, validateSearch: sanitizeSearch, component: () => <ViewGuard view={view} component={component} /> });
});
const router = createRouter({ routeTree: rootRoute.addChildren(viewRoutes), defaultNotFoundComponent: () => <AdminError error={new Error("This admin page does not exist or is not available to your role.")} /> });

declare module "@tanstack/react-router" { interface Register { router: typeof router } }

function App() {
  // Polled so a revoked or expired support session is noticed without a reload.
  const session = useQuery({ queryKey: sessionQueryKey, queryFn: api.session, retry: false, refetchInterval: 30_000 });
  if (session.isPending) return <div role="status" className="grid min-h-screen place-items-center bg-kumo-canvas text-kumo-subtle"><span className="flex items-center gap-2"><Loader />Checking your operator session</span></div>;
  if (session.error instanceof Unauthenticated) return <SignIn />;
  // A signed-in account without a platform role can switch to an operator account here.
  if (session.error instanceof PermissionDenied) return <SignIn notice="This account has no platform role. Sign in as a platform operator." />;
  if (session.error) return <main className="bg-kumo-canvas p-8"><AdminError error={session.error} retry={() => void session.refetch()} /><p className="mt-3 text-sm text-kumo-subtle">{errorMessage(session.error)}</p></main>;
  return <AdminProvider session={session.data} registry={adminRegistry}><CommandProvider><RouterProvider router={router} /></CommandProvider></AdminProvider>;
}

const element = document.querySelector("#root");
if (!element) throw new Error("Missing #root element");
const overlays = document.querySelector<HTMLElement>("#admin-overlays") ?? document.body;
createRoot(element).render(<StrictMode>
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })}>
    <LinkProvider component={RouterBridge}>
      <KumoPortalProvider container={overlays}>
        <TooltipProvider>
          <Toasty><ThemeProvider><App /></ThemeProvider></Toasty>
        </TooltipProvider>
      </KumoPortalProvider>
    </LinkProvider>
  </QueryClientProvider>
</StrictMode>);
