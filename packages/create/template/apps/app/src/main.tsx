import { useForm } from "@tanstack/react-form";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, RouterProvider, createRootRoute, createRoute, createRouter, useNavigate } from "@tanstack/react-router";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { healthResponseSchema } from "@__TRESTLE_PROJECT_NAME__/contracts";
import { authClient } from "./auth-client";
import { billingSubscriptionQueryKey } from "./tenant-query.js";
import { WebhookInspection } from "./webhook-inspection";
import "./styles.css";

const apiOrigin = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\/$/u, "") ?? "";
const api = (path: string) => `${apiOrigin}${path}`;

function OrganizationSwitcher() {
  const { data: session } = authClient.useSession();
  const { data: organizations } = authClient.useListOrganizations();
  const { data: activeOrganization } = authClient.useActiveOrganization();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  if (!session || !organizations?.length) return null;
  return <label className="flex items-center gap-2 text-sm font-medium text-slate-600">Organization
    <select aria-label="Active organization" className="rounded-lg border border-slate-300 px-2 py-1" value={activeOrganization?.id ?? ""} onChange={async (event) => {
      const organizationId = event.target.value;
      if (!organizationId) return;
      setError(undefined);
      const result = await authClient.organization.setActive({ organizationId });
      if (result.error) { setError(result.error.message ?? "Could not switch organizations"); return; }
      queryClient.clear();
    }}>
      <option value="">Select an organization</option>
      {organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name}</option>)}
    </select>
    {error && <span role="alert" className="text-red-700">{error}</span>}
  </label>;
}

function Shell() {
  return <main className="mx-auto max-w-4xl px-6 py-12">
    <nav className="mb-10 flex items-center justify-between">
      <Link to="/" className="text-lg font-bold tracking-tight">TrestleJS</Link>
      <div className="flex gap-5 text-sm font-medium text-slate-600">
        <Link to="/sign-in" activeProps={{ className: "text-brand-500" }}>Sign in</Link>
        <Link to="/sign-up" activeProps={{ className: "text-brand-500" }}>Create account</Link>
        <Link to="/dashboard" activeProps={{ className: "text-brand-500" }}>Dashboard</Link>
        <Link to="/settings/webhooks" activeProps={{ className: "text-brand-500" }}>Webhooks</Link>
        {/* trestle:resource-links */}
      </div>
    </nav>
    <OrganizationSwitcher />
    <Outlet />
  </main>;
}

function Home() {
  const health = useQuery({ queryKey: ["health"], queryFn: async () => {
    const response = await fetch(api("/api/health"));
    return healthResponseSchema.parse(await response.json());
  }});
  return <section className="card p-10">
    <p className="eyebrow">TrestleJS</p>
    <h1 className="mt-3 text-4xl font-semibold tracking-tight">__TRESTLE_PROJECT_NAME__</h1>
    <p className="mt-4 max-w-2xl text-lg text-slate-600">React, TanStack, Better Auth, Hono, Drizzle, PostgreSQL, and Cloudflare—with the architectural boundaries already in place.</p>
    <div className="mt-8 rounded-xl bg-slate-950 px-4 py-3 font-mono text-sm text-slate-100">API: {health.isPending ? "checking" : health.data?.status ?? "unavailable"}</div>
  </section>;
}

function Field(props: { label: string; type: string; value: string; onChange: (value: string) => void }) {
  return <label className="block text-sm font-medium text-slate-700">{props.label}
    <input className="mt-2 w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-brand-500 focus:ring-2 focus:ring-blue-100" required minLength={props.type === "password" ? 8 : undefined} type={props.type} value={props.value} onChange={(event) => props.onChange(event.target.value)} />
  </label>;
}

function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string>();
  const form = useForm({
    defaultValues: { name: "", email: "", password: "" },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const result = mode === "sign-up"
        ? await authClient.signUp.email({ name: value.name, email: value.email, password: value.password })
        : await authClient.signIn.email({ email: value.email, password: value.password });
      if (result.error) { setError(result.error.message ?? "Authentication failed"); return; }
      queryClient.clear();
      if (mode === "sign-in") {
        window.location.assign("/dashboard");
        return;
      }
      await navigate({ to: "/check-email" });
    },
  });
  return <section className="card mx-auto max-w-lg p-8">
    <p className="eyebrow">Account</p>
    <h1 className="mt-2 text-3xl font-semibold">{mode === "sign-up" ? "Create your account" : "Welcome back"}</h1>
    <form className="mt-8 space-y-5" onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
      {mode === "sign-up" && <form.Field name="name">{(field) => <Field label="Name" type="text" value={field.state.value} onChange={field.handleChange} />}</form.Field>}
      <form.Field name="email">{(field) => <Field label="Email" type="email" value={field.state.value} onChange={field.handleChange} />}</form.Field>
      <form.Field name="password">{(field) => <Field label="Password" type="password" value={field.state.value} onChange={field.handleChange} />}</form.Field>
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>{([canSubmit, isSubmitting]) => <button className="button w-full" disabled={!canSubmit} type="submit">{isSubmitting ? "Working…" : mode === "sign-up" ? "Create account" : "Sign in"}</button>}</form.Subscribe>
      {mode === "sign-in" && <Link className="block text-center text-sm font-medium text-brand-500" to="/forgot-password">Forgot your password?</Link>}
    </form>
  </section>;
}

function CheckEmail() {
  const inbox = useQuery({ queryKey: ["captured-emails"], refetchInterval: 1000, queryFn: async () => {
    const response = await fetch(api("/api/dev/emails"));
    if (!response.ok) return { emails: [] as Array<{ id: string; to: string[]; subject: string; text: string }> };
    return response.json() as Promise<{ emails: Array<{ id: string; to: string[]; subject: string; text: string }> }>;
  }});
  return <section className="card p-8">
    <p className="eyebrow">Local email capture</p>
    <h1 className="mt-2 text-3xl font-semibold">Check your email</h1>
    <p className="mt-3 text-slate-600">Verification, password-reset, and invitation messages appear here during local development.</p>
    <div className="mt-6 space-y-3">{inbox.data?.emails.map((email) => {
      const link = email.text.match(/https?:\/\/\S+/u)?.[0];
      return <article className="rounded-xl border border-slate-200 p-4" key={email.id}><p className="font-semibold">{email.subject}</p><p className="text-sm text-slate-600">To: {email.to.join(", ")}</p>{link && <a className="mt-2 block text-sm font-semibold text-brand-500" href={link}>Open message link</a>}</article>;
    })}</div>
  </section>;
}

function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string>();
  return <section className="card mx-auto max-w-lg p-8"><p className="eyebrow">Account recovery</p><h1 className="mt-2 text-3xl font-semibold">Reset your password</h1>
    <form className="mt-6 space-y-4" onSubmit={async (event) => { event.preventDefault(); const result = await authClient.requestPasswordReset({ email, redirectTo: `${window.location.origin}/reset-password` }); setMessage(result.error ? result.error.message ?? "Unable to request reset" : "If the account exists, a reset message has been sent."); }}>
      <Field label="Email" type="email" value={email} onChange={setEmail} /><button className="button w-full" type="submit">Send reset link</button>{message && <p className="text-sm text-slate-600">{message}</p>}
    </form></section>;
}

function ResetPassword() {
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string>();
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  return <section className="card mx-auto max-w-lg p-8"><p className="eyebrow">Account recovery</p><h1 className="mt-2 text-3xl font-semibold">Choose a new password</h1>
    <form className="mt-6 space-y-4" onSubmit={async (event) => { event.preventDefault(); const result = await authClient.resetPassword({ newPassword: password, token }); setMessage(result.error ? result.error.message ?? "Unable to reset password" : "Password updated. You can sign in now."); }}>
      <Field label="New password" type="password" value={password} onChange={setPassword} /><button className="button w-full" type="submit">Update password</button>{message && <p className="text-sm text-slate-600">{message}</p>}
    </form></section>;
}

function AcceptInvitation() {
  const invitationId = new URLSearchParams(window.location.search).get("id") ?? "";
  const [message, setMessage] = useState<string>();
  return <section className="card p-8"><p className="eyebrow">Organization invitation</p><h1 className="mt-2 text-3xl font-semibold">Join the organization</h1><button className="button mt-6" onClick={async () => { const result = await authClient.organization.acceptInvitation({ invitationId }); setMessage(result.error ? result.error.message ?? "Unable to accept invitation" : "Invitation accepted."); }}>Accept invitation</button>{message && <p className="mt-3 text-sm text-slate-600">{message}</p>}</section>;
}

function Dashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session, isPending } = authClient.useSession();
  const [organizationName, setOrganizationName] = useState("");
  const [message, setMessage] = useState<string>();
  const [inviteEmail, setInviteEmail] = useState("");
  useEffect(() => { if (!isPending && !session) void navigate({ to: "/sign-in", replace: true }); }, [isPending, navigate, session]);
  if (isPending || !session) return <p className="text-slate-600">Loading your account…</p>;
  const createOrganization = async () => {
    setMessage(undefined);
    const slug = organizationName.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const result = await authClient.organization.create({ name: organizationName, slug });
    setMessage(result.error ? result.error.message ?? "Could not create organization" : `Created ${organizationName}`);
    if (!result.error) { setOrganizationName(""); queryClient.clear(); }
  };
  return <section className="card p-8">
    <p className="eyebrow">Protected route</p>
    <h1 className="mt-2 text-3xl font-semibold">Hello, {session.user.name}</h1>
    <p className="mt-2 text-slate-600">Signed in as {session.user.email}</p>
    <div className="mt-8 border-t border-slate-200 pt-7">
      <h2 className="text-lg font-semibold">Create an organization</h2>
      <div className="mt-3 flex gap-3">
        <input className="min-w-0 flex-1 rounded-xl border border-slate-300 px-4 py-3" placeholder="Acme, Inc." value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} />
        <button className="button" disabled={!organizationName.trim()} onClick={() => void createOrganization()}>Create</button>
      </div>
      {message && <p className="mt-3 text-sm text-slate-600">{message}</p>}
    </div>
    <div className="mt-8 border-t border-slate-200 pt-7"><h2 className="text-lg font-semibold">Invite a member</h2><div className="mt-3 flex gap-3"><input className="min-w-0 flex-1 rounded-xl border border-slate-300 px-4 py-3" type="email" placeholder="person@example.com" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} /><button className="button" disabled={!inviteEmail} onClick={async () => { const result = await authClient.organization.inviteMember({ email: inviteEmail, role: "member" }); setMessage(result.error ? result.error.message ?? "Could not send invitation" : `Invited ${inviteEmail}`); if (!result.error) setInviteEmail(""); }}>Invite</button></div></div>
    <button className="mt-8 text-sm font-semibold text-red-600" onClick={async () => { await authClient.signOut(); queryClient.clear(); await navigate({ to: "/" }); }}>Sign out</button>
  </section>;
}

function BillingSettings() {
  const { data: session } = authClient.useSession();
  const { data: activeOrganization } = authClient.useActiveOrganization();
  const organizationId = activeOrganization?.id;
  const subscription = useQuery({ queryKey: billingSubscriptionQueryKey(session?.user.id, organizationId), enabled: Boolean(session?.user.id && organizationId), queryFn: async () => { const response = await fetch(api("/api/billing/subscription"), { credentials: "include", headers: { "x-trestle-tenant": organizationId! } }); if (!response.ok) throw new Error("Select an organization before managing billing"); return response.json() as Promise<{ subscription: null | { plan: string; planVersion: number; status: string; currentPeriodEnd?: string; cancelAtPeriodEnd: boolean; entitlements: string[]; effectiveEntitlements?: Array<{ code: string; enabled: boolean; source: string; inheritedFrom?: string }> }; usage: Array<{ meter: string; used: number; limit: number | null }> }>; } });
  const [message, setMessage] = useState<string>();
  const manage = async () => { if (!organizationId) return; const response = await fetch(api("/api/billing/portal"), { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-trestle-tenant": organizationId }, body: JSON.stringify({ requestId: crypto.randomUUID() }) }); const result = await response.json() as { url?: string; error?: string }; if (result.url) window.location.assign(result.url); else setMessage(result.error ?? "Unable to open billing portal"); };
  const included = subscription.data?.subscription?.effectiveEntitlements ?? subscription.data?.subscription?.entitlements.map((code) => ({ code, enabled: true, source: "plan" })) ?? [];
  return <section className="card p-8"><p className="eyebrow">Settings</p><h1 className="mt-2 text-3xl font-semibold">Plan and usage</h1>{!organizationId ? <p className="mt-4">Select an organization to view billing.</p> : subscription.isPending ? <p className="mt-4">Loading…</p> : subscription.error ? <p className="mt-4 text-red-700">{subscription.error.message}</p> : subscription.data?.subscription ? <div className="mt-6 space-y-2"><p>Current plan: <strong>{subscription.data.subscription.plan}</strong> <span className="text-slate-500">version {subscription.data.subscription.planVersion}</span></p><p>Status: {subscription.data.subscription.status}</p><p>{subscription.data.subscription.cancelAtPeriodEnd ? "Cancels at period end" : "Renews automatically"}</p><div className="pt-4"><h2 className="font-semibold">Included capabilities</h2><ul className="mt-2 list-disc pl-5 text-sm text-slate-600">{included.filter((item) => item.enabled).map((item) => <li key={item.code}>{item.code} <span className="text-slate-400">({item.source}{"inheritedFrom" in item && item.inheritedFrom ? `: ${item.inheritedFrom}` : ""})</span></li>)}</ul></div><div className="pt-4"><h2 className="font-semibold">Usage</h2>{subscription.data.usage.length ? <ul className="mt-2 text-sm text-slate-600">{subscription.data.usage.map((meter) => <li key={meter.meter}>{meter.meter}: {meter.used}{meter.limit === null ? "" : ` / ${meter.limit}`}</li>)}</ul> : <p className="mt-2 text-sm text-slate-600">This plan has no metered usage.</p>}</div><button className="button mt-4" onClick={() => void manage()}>Manage billing</button></div> : <p className="mt-4">No active subscription.</p>}{message && <p className="mt-3 text-red-700">{message}</p>}</section>;
}

const rootRoute = createRootRoute({ component: Shell });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Home });
const signInRoute = createRoute({ getParentRoute: () => rootRoute, path: "/sign-in", component: () => <AuthForm mode="sign-in" /> });
const signUpRoute = createRoute({ getParentRoute: () => rootRoute, path: "/sign-up", component: () => <AuthForm mode="sign-up" /> });
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/dashboard", component: Dashboard });
const checkEmailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/check-email", component: CheckEmail });
const forgotPasswordRoute = createRoute({ getParentRoute: () => rootRoute, path: "/forgot-password", component: ForgotPassword });
const resetPasswordRoute = createRoute({ getParentRoute: () => rootRoute, path: "/reset-password", component: ResetPassword });
const acceptInvitationRoute = createRoute({ getParentRoute: () => rootRoute, path: "/accept-invitation", component: AcceptInvitation });
const billingRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/billing", component: BillingSettings });
const webhookInspectionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/webhooks", component: WebhookInspection });
const routeTree = rootRoute.addChildren([indexRoute, signInRoute, signUpRoute, dashboardRoute, checkEmailRoute, forgotPasswordRoute, resetPasswordRoute, acceptInvitationRoute, billingRoute, webhookInspectionRoute]);
const router = createRouter({ routeTree });
const queryClient = new QueryClient();

declare module "@tanstack/react-router" { interface Register { router: typeof router; } }

const element = document.querySelector("#root");
if (!element) throw new Error("Missing #root element");
createRoot(element).render(<StrictMode><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></StrictMode>);
