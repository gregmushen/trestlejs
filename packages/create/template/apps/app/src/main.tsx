import { useForm } from "@tanstack/react-form";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, RouterProvider, createRootRoute, createRoute, createRouter, useNavigate } from "@tanstack/react-router";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { healthResponseSchema } from "@__TRESTLE_PROJECT_NAME__/contracts";
import { authClient } from "./auth-client";
import { MembersAndRoles } from "./settings/access";
import { NotificationBell, NotificationInbox, NotificationPreferences } from "./settings/notifications";
import { SecuritySettings } from "./settings/security";
import { IdentitySettings } from "./settings/identity";
import { Webhooks } from "./settings/webhooks";
import { ServiceAccounts } from "./settings/api-keys";
import { TenantApiError } from "./settings/api";
import { BillingSettings } from "./settings/billing";
import { PlanAndUsage } from "./settings/plan-usage";
import { LanguageAndRegion, OrganizationRegionalSettings, RegionalLink } from "./settings/regional";
import "./styles.css";

const apiOrigin = (import.meta.env.VITE_API_ORIGIN as string | undefined)?.replace(/\/$/u, "") ?? "";
const api = (path: string) => `${apiOrigin}${path}`;

type AuthMethods = { passkeys: boolean; twoFactor: boolean; sso: "disabled" | "better-auth" | "workos"; directory: "disabled" | "better-auth-scim" | "workos" };
/** Declared sign-in methods; the sign-in page and navigation adapt to them without a session. */
function useAuthMethods() {
  return useQuery({ queryKey: ["auth-methods"], staleTime: Infinity, queryFn: async () => await (await fetch(api("/api/auth-methods"))).json() as AuthMethods });
}

const ssoErrors: Record<string, string> = {
  sso_domain_not_verified: "Your organization has not verified this email domain for single sign-on.",
  sso_organization_mismatch: "The identity provider answered for a different organization.",
  sso_state_mismatch: "The sign-in attempt expired. Start again.",
  sso_provider_error: "The identity provider could not complete sign-in.",
  sso_failed: "Single sign-on did not complete.",
};

function Shell() {
  return <main className="mx-auto max-w-4xl px-6 py-12">
    <nav className="mb-10 flex items-center justify-between">
      <Link to="/" className="text-lg font-bold tracking-tight">TrestleJS</Link>
      <div className="flex gap-5 text-sm font-medium text-slate-600">
        <Link to="/sign-in" activeProps={{ className: "text-brand-500" }}>Sign in</Link>
        <Link to="/sign-up" activeProps={{ className: "text-brand-500" }}>Create account</Link>
        <Link to="/dashboard" activeProps={{ className: "text-brand-500" }}>Dashboard</Link>
        <Link to="/settings/plan" activeProps={{ className: "text-brand-500" }}>Plan</Link>
        <Link to="/settings/members" activeProps={{ className: "text-brand-500" }}>Members</Link>
        <Link to="/settings/api-keys" activeProps={{ className: "text-brand-500" }}>API keys</Link>
        <Link to="/settings/billing" activeProps={{ className: "text-brand-500" }}>Billing</Link>
        <Link to="/settings/webhooks" activeProps={{ className: "text-brand-500" }}>Webhooks</Link>
        <RegionalLink />
        <Link to="/settings/security" activeProps={{ className: "text-brand-500" }}>Security</Link>
        <Link to="/account/language-region" activeProps={{ className: "text-brand-500" }}>Language & Region</Link>
        <IdentityLink />
        <NotificationBell />
        {/* trestle:resource-links */}
      </div>
    </nav>
    <Outlet />
  </main>;
}

function IdentityLink() {
  const methods = useAuthMethods();
  if (!methods.data || (methods.data.sso === "disabled" && methods.data.directory === "disabled")) return null;
  return <Link to="/settings/identity" activeProps={{ className: "text-brand-500" }}>Identity</Link>;
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
  const methods = useAuthMethods();
  const [error, setError] = useState<string | undefined>(() => ssoErrors[new URLSearchParams(window.location.search).get("error") ?? ""]);
  const [ssoEmail, setSsoEmail] = useState("");
  const [ssoOpen, setSsoOpen] = useState(false);
  const startSso = async () => {
    setError(undefined);
    const callbackURL = `${window.location.origin}/dashboard`;
    if (methods.data?.sso === "workos") {
      const response = await fetch(api("/api/auth/workos/sign-in"), { method: "POST", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: ssoEmail, callbackURL: "/dashboard" }) });
      const body = await response.json().catch(() => ({})) as { url?: string; message?: string };
      if (!response.ok || !body.url) { setError(body.message ?? "Single sign-on is not available for this email"); return; }
      window.location.assign(body.url);
      return;
    }
    const result = await authClient.signIn.sso({ email: ssoEmail, callbackURL, errorCallbackURL: `${window.location.origin}/sign-in?error=sso_failed` });
    if (result.error) setError(result.error.message ?? "Single sign-on is not available for this email");
  };
  const form = useForm({
    defaultValues: { name: "", email: "", password: "" },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const result = mode === "sign-up"
        ? await authClient.signUp.email({ name: value.name, email: value.email, password: value.password })
        : await authClient.signIn.email({ email: value.email, password: value.password });
      if (result.error) { setError(result.error.message ?? "Authentication failed"); return; }
      // Accounts with an authenticator must complete the second factor before a session exists.
      if ((result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) { await navigate({ to: "/two-factor" }); return; }
      await navigate({ to: mode === "sign-up" ? "/check-email" : "/dashboard" });
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
      {mode === "sign-in" && methods.data?.passkeys && <button type="button" className="button-secondary w-full" onClick={async () => { const result = await authClient.signIn.passkey(); if (result?.error) setError(result.error.message ?? "Passkey sign-in failed"); else await navigate({ to: "/dashboard" }); }}>Sign in with a passkey</button>}
      {mode === "sign-in" && <Link className="block text-center text-sm font-medium text-brand-500" to="/forgot-password">Forgot your password?</Link>}
    </form>
    {mode === "sign-in" && methods.data && methods.data.sso !== "disabled" && <div className="mt-6 border-t border-slate-200 pt-6">
      {ssoOpen ? <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void startSso(); }}>
        <Field label="Work email" type="email" value={ssoEmail} onChange={setSsoEmail} />
        <button className="button w-full" type="submit">Continue with single sign-on</button>
      </form> : <button type="button" className="button-secondary w-full" onClick={() => setSsoOpen(true)}>Sign in with single sign-on</button>}
    </div>}
  </section>;
}

function TwoFactorChallenge() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState<string>();
  return <section className="card mx-auto max-w-lg p-8">
    <p className="eyebrow">Two-factor authentication</p>
    <h1 className="mt-2 text-3xl font-semibold">Enter your code</h1>
    <form className="mt-6 space-y-4" onSubmit={async (event) => {
      event.preventDefault();
      const result = backup ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() }) : await authClient.twoFactor.verifyTotp({ code: code.trim() });
      if (result.error) { setError(result.error.message ?? "That code was not accepted"); return; }
      await navigate({ to: "/dashboard" });
    }}>
      <Field label={backup ? "Backup code" : "Authentication code"} type="text" value={code} onChange={setCode} />
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <button className="button w-full" type="submit" disabled={!code.trim()}>Verify</button>
      <button type="button" className="block w-full text-center text-sm font-medium text-brand-500" onClick={() => setBackup(!backup)}>{backup ? "Use your authenticator app" : "Use a backup code"}</button>
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

function slugFor(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "organization";
}

function Dashboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session, isPending } = authClient.useSession();
  const organizations = authClient.useListOrganizations();
  const active = authClient.useActiveOrganization();
  const [organizationName, setOrganizationName] = useState("");
  const [message, setMessage] = useState<string>();
  const [inviteEmail, setInviteEmail] = useState("");
  useEffect(() => { if (!isPending && !session) void navigate({ to: "/sign-in", replace: true }); }, [isPending, navigate, session]);
  // A member of exactly one organization works in it without an extra click.
  useEffect(() => {
    if (active.isPending || active.data || organizations.data?.length !== 1) return;
    void authClient.organization.setActive({ organizationId: organizations.data[0]!.id }).then(() => queryClient.invalidateQueries());
  }, [active.data, active.isPending, organizations.data, queryClient]);
  if (isPending || !session) return <p className="text-slate-600">Loading your account…</p>;
  // Tenant data is cached per organization; drop it all when the active organization changes.
  const switchTo = async (organizationId: string) => {
    const result = await authClient.organization.setActive({ organizationId });
    if (result.error) { setMessage(result.error.message ?? "Could not switch organization"); return; }
    queryClient.clear();
    setMessage(undefined);
  };
  const createOrganization = async () => {
    setMessage(undefined);
    const name = organizationName.trim();
    // Names need not be unique; slugs must be, so a taken slug gets a short suffix.
    let result = await authClient.organization.create({ name, slug: slugFor(name) });
    if (result.error && /slug|exists/iu.test(result.error.message ?? "")) result = await authClient.organization.create({ name, slug: `${slugFor(name)}-${crypto.randomUUID().slice(0, 6)}` });
    if (result.error) { setMessage(result.error.message ?? "Could not create organization"); return; }
    setOrganizationName("");
    if (result.data?.id) await switchTo(result.data.id);
    setMessage(`Created ${name}`);
  };
  return <section className="card p-8">
    <p className="eyebrow">Protected route</p>
    <h1 className="mt-2 text-3xl font-semibold">Hello, {session.user.name}</h1>
    <p className="mt-2 text-slate-600">Signed in as {session.user.email}</p>
    <div className="mt-8 border-t border-slate-200 pt-7">
      <h2 className="text-lg font-semibold">Your organizations</h2>
      {organizations.data?.length ? <ul className="mt-3 space-y-2">{organizations.data.map((organization) => <li key={organization.id} className="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3">
        <span className="font-medium">{organization.name}</span>
        {active.data?.id === organization.id ? <span className="text-sm font-semibold text-brand-500">Active</span> : <button className="text-sm font-semibold text-brand-500" onClick={() => void switchTo(organization.id)}>Switch to</button>}
      </li>)}</ul> : <p className="mt-3 text-sm text-slate-600">You are not a member of any organization yet. Create one to get started.</p>}
    </div>
    <div className="mt-8 border-t border-slate-200 pt-7">
      <h2 className="text-lg font-semibold">Create an organization</h2>
      <div className="mt-3 flex gap-3">
        <input className="min-w-0 flex-1 rounded-xl border border-slate-300 px-4 py-3" placeholder="Acme, Inc." value={organizationName} onChange={(event) => setOrganizationName(event.target.value)} />
        <button className="button" disabled={!organizationName.trim()} onClick={() => void createOrganization()}>Create</button>
      </div>
      {message && <p className="mt-3 text-sm text-slate-600">{message}</p>}
    </div>
    {active.data && <div className="mt-8 border-t border-slate-200 pt-7"><h2 className="text-lg font-semibold">Invite a member to {active.data.name}</h2><div className="mt-3 flex gap-3"><input className="min-w-0 flex-1 rounded-xl border border-slate-300 px-4 py-3" type="email" placeholder="person@example.com" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} /><button className="button" disabled={!inviteEmail} onClick={async () => { const result = await authClient.organization.inviteMember({ email: inviteEmail, role: "member" }); setMessage(result.error ? result.error.message ?? "Could not send invitation" : `Invited ${inviteEmail}`); if (!result.error) setInviteEmail(""); }}>Invite</button></div></div>}
    <button className="mt-8 text-sm font-semibold text-red-600" onClick={async () => { await authClient.signOut(); queryClient.clear(); await navigate({ to: "/" }); }}>Sign out</button>
  </section>;
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
const planRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/plan", component: PlanAndUsage });
const membersRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/members", component: MembersAndRoles });
const apiKeysRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/api-keys", component: ServiceAccounts });
const twoFactorRoute = createRoute({ getParentRoute: () => rootRoute, path: "/two-factor", component: TwoFactorChallenge });
const securityRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/security", component: SecuritySettings });
const identityRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/identity", component: IdentitySettings });
const webhooksRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/webhooks", component: Webhooks });
const notificationsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/notifications", component: NotificationInbox });
const notificationPreferencesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/notifications", component: NotificationPreferences });
const regionalRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/regional", component: OrganizationRegionalSettings });
const languageRegionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/account/language-region", component: LanguageAndRegion });
const routeTree = rootRoute.addChildren([indexRoute, signInRoute, signUpRoute, dashboardRoute, checkEmailRoute, forgotPasswordRoute, resetPasswordRoute, acceptInvitationRoute, billingRoute, planRoute, membersRoute, apiKeysRoute, webhooksRoute, notificationsRoute, notificationPreferencesRoute, twoFactorRoute, securityRoute, identityRoute, regionalRoute, languageRegionRoute]);
const router = createRouter({ routeTree });
// Client errors (401/403/404/422) are answers, not transient failures; only retry server errors.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: (count, error) => !(error instanceof TenantApiError && error.status < 500) && count < 2 } } });

declare module "@tanstack/react-router" { interface Register { router: typeof router; } }

const element = document.querySelector("#root");
if (!element) throw new Error("Missing #root element");
createRoot(element).render(<StrictMode><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></StrictMode>);
