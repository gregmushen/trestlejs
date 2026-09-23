import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, RouterProvider, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { StrictMode, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { AdminApiError, adminApi, authClient, type AdminSession, type Health } from "./api";
import { adminViews } from "./registry";
import { ArtifactsView } from "./views/artifacts";
import { AsyncView } from "./views/async";
import { HealthView } from "./views/health";
import { OverviewView } from "./views/overview";
import { WebhooksView } from "./views/webhooks";
import "./styles.css";

const viewComponents: Record<string, () => ReactNode> = { overview: OverviewView, health: HealthView, async: AsyncView, webhooks: WebhooksView, artifacts: ArtifactsView };

function useAdminSession() {
  return useQuery({ queryKey: ["admin-session"], retry: false, queryFn: () => adminApi<AdminSession>("/api/admin/session") });
}

function SignIn({ error }: { error?: string }) {
  const client = useQueryClient();
  const [message, setMessage] = useState(error);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const result = await authClient.signIn.email({ email: String(form.get("email")), password: String(form.get("password")) });
    if (result.error) { setMessage("Those credentials were not accepted."); return; }
    await client.invalidateQueries({ queryKey: ["admin-session"] });
  };
  return <main className="mx-auto mt-24 max-w-sm rounded-xl border border-border bg-surface p-8">
    <p className="text-sm font-semibold uppercase tracking-wide text-muted">Platform admin</p>
    <h1 className="mt-2 text-2xl font-semibold">Sign in</h1>
    {message && <p role="alert" className="mt-3 text-sm text-destructive">{message}</p>}
    <form className="mt-6 space-y-4" onSubmit={(event) => void submit(event)}>
      <label className="block text-sm">Email<input name="email" type="email" autoComplete="username" required className="mt-1 w-full rounded-lg border border-border px-3 py-2" /></label>
      <label className="block text-sm">Password<input name="password" type="password" autoComplete="current-password" required className="mt-1 w-full rounded-lg border border-border px-3 py-2" /></label>
      <button type="submit" className="w-full rounded-lg bg-primary px-3 py-2 font-medium text-white">Sign in</button>
    </form>
  </main>;
}

function Shell() {
  const session = useAdminSession();
  const client = useQueryClient();
  const health = useQuery({ queryKey: ["admin-health"], enabled: Boolean(session.data), retry: false, queryFn: () => adminApi<Health>("/api/admin/health") });
  if (session.isPending) return <p className="p-8">Loading…</p>;
  if (session.error instanceof AdminApiError && session.error.status === 401) return <SignIn />;
  if (session.error) return <SignIn error={session.error instanceof AdminApiError && session.error.code === "no_platform_roles" ? "This account has no platform role." : session.error.message} />;
  const unconfigured = new Set(health.data?.application.capabilities.filter((capability) => capability.state !== "configured").map((capability) => capability.id));
  const visible = session.data.views.filter((view) => view.allowed);
  const groups = [...new Set(visible.map((view) => view.group))];
  return <div className="flex min-h-screen">
    <nav aria-label="Admin" className="w-56 shrink-0 border-r border-border bg-surface p-4">
      <p className="text-sm font-semibold">Platform admin</p>
      <p className="mt-1 truncate text-xs text-muted">{session.data.operator.email}</p>
      {groups.map((group) => <div key={group} className="mt-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">{group}</p>
        <ul className="mt-2 space-y-1">{visible.filter((view) => view.group === group).map((view) => <li key={view.id}>
          <Link to={view.path} className="block rounded px-2 py-1 text-sm" activeProps={{ className: "bg-background font-medium" }}>
            {view.label}{view.capability && unconfigured.has(view.capability) && <span className="ml-2 text-xs text-muted">(not configured)</span>}
          </Link>
        </li>)}</ul>
      </div>)}
      <button className="mt-8 text-sm text-muted underline" onClick={() => void authClient.signOut().then(() => client.invalidateQueries({ queryKey: ["admin-session"] }))}>Sign out</button>
    </nav>
    <main className="flex-1 p-8"><Outlet /></main>
  </div>;
}

const rootRoute = createRootRoute({ component: Shell });
const viewRoutes = adminViews.map((view) => createRoute({ getParentRoute: () => rootRoute, path: view.path, component: viewComponents[view.id] ?? (() => <p>This view has no component.</p>) }));
const router = createRouter({ routeTree: rootRoute.addChildren(viewRoutes) });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
