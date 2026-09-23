import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { authClient } from "../auth-client";
import { formatDate } from "./api";

type Enrollment = { totpURI: string; backupCodes: string[] };
type Passkey = { id: string; name?: string | null; deviceType: string; backedUp: boolean; createdAt: string | Date };

/**
 * Security settings: Better Auth owns TOTP and WebAuthn; this page is the
 * enrollment surface. Secrets and backup codes are shown once, at enrollment.
 */
export function SecuritySettings() {
  const client = useQueryClient();
  const account = useQuery({ queryKey: ["security"], queryFn: async () => {
    const [session, passkeys] = await Promise.all([authClient.getSession(), authClient.passkey.listUserPasskeys()]);
    return { twoFactorEnabled: Boolean((session.data?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled), passkeys: (passkeys.data ?? []) as Passkey[] };
  } });
  const [password, setPassword] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string>();
  const refresh = () => void client.invalidateQueries({ queryKey: ["security"] });
  const report = (result: { error?: { message?: string | undefined } | null } | null | undefined, success: string) => { setMessage(result?.error ? result.error.message ?? "Something went wrong" : success); if (!result?.error) refresh(); return !result?.error; };
  const secret = enrollment ? new URL(enrollment.totpURI).searchParams.get("secret") ?? "" : "";
  return <section className="space-y-6">
    <div className="card p-8">
      <p className="eyebrow">Account</p>
      <h1 className="mt-2 text-3xl font-semibold">Security</h1>
      <p className="mt-2 text-slate-600">Add a second factor or a passkey to protect your account. Passkeys resist phishing; authenticator codes add a second step after your password.</p>
      {message && <p role="status" className="mt-4 rounded-lg bg-slate-100 px-3 py-2 text-sm">{message}</p>}
    </div>
    <div className="card p-8">
      <h2 className="text-lg font-semibold">Authenticator app {account.data?.twoFactorEnabled ? <span className="ml-2 rounded bg-emerald-50 px-2 text-sm text-emerald-700">enabled</span> : null}</h2>
      {enrollment ? <div className="mt-4 space-y-3">
        <p className="text-sm">Add this setup key to your authenticator app, then enter the code it shows. It will not be shown again.</p>
        <code className="block break-all rounded-lg bg-slate-100 px-3 py-2 font-mono text-sm">{secret}</code>
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3"><p className="text-sm font-semibold">Backup codes: store them now</p><ul className="mt-1 grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-5">{enrollment.backupCodes.map((backup) => <li key={backup}>{backup}</li>)}</ul></div>
        <form className="flex gap-2" onSubmit={async (event) => { event.preventDefault(); if (report(await authClient.twoFactor.verifyTotp({ code: code.trim() }), "Authenticator enabled.")) { setEnrollment(undefined); setCode(""); } }}>
          <input aria-label="Authentication code" className="rounded-lg border px-3 py-2" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
          <button className="button" type="submit" disabled={!code.trim()}>Verify and enable</button>
        </form>
      </div> : <form className="mt-4 flex flex-wrap gap-2" onSubmit={async (event) => {
        event.preventDefault();
        if (account.data?.twoFactorEnabled) { report(await authClient.twoFactor.disable({ password }), "Authenticator disabled."); setPassword(""); return; }
        const result = await authClient.twoFactor.enable({ password }); setPassword("");
        if (result.error) setMessage(result.error.message ?? "Could not start enrollment"); else { setMessage(undefined); setEnrollment(result.data as Enrollment); }
      }}>
        <input aria-label="Current password" type="password" autoComplete="current-password" className="rounded-lg border px-3 py-2" placeholder="Current password" value={password} onChange={(event) => setPassword(event.target.value)} />
        <button className={account.data?.twoFactorEnabled ? "button-secondary" : "button"} type="submit" disabled={!password}>{account.data?.twoFactorEnabled ? "Disable authenticator" : "Set up authenticator"}</button>
      </form>}
    </div>
    <div className="card p-8">
      <h2 className="text-lg font-semibold">Passkeys</h2>
      <form className="mt-4 flex flex-wrap gap-2" onSubmit={async (event) => { event.preventDefault(); if (report(await authClient.passkey.addPasskey({ name: name.trim() || "My passkey" }) as never, "Passkey added.")) setName(""); }}>
        <input aria-label="Passkey name" className="rounded-lg border px-3 py-2" placeholder="Name (optional)" value={name} onChange={(event) => setName(event.target.value)} />
        <button className="button" type="submit">Add passkey</button>
      </form>
      <ul className="mt-4 divide-y divide-slate-100">{account.data?.passkeys.map((passkey) => <li key={passkey.id} className="flex items-center justify-between py-2 text-sm">
        <span><span className="font-medium">{passkey.name ?? "Passkey"}</span> <span className="text-slate-500">{passkey.deviceType}{passkey.backedUp ? " · synced" : ""} · added {formatDate(String(passkey.createdAt))}</span></span>
        <button className="text-red-600" onClick={async () => { report(await authClient.passkey.deletePasskey({ id: passkey.id }) as never, "Passkey removed."); }}>Remove</button>
      </li>)}</ul>
      {account.data?.passkeys.length === 0 && <p className="mt-2 text-sm text-slate-600">No passkeys yet.</p>}
    </div>
  </section>;
}
