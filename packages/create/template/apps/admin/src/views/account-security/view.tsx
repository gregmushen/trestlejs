import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { sessionQueryKey } from "../../api";
import { authClient } from "../../auth-client";
import { useAdminCommands } from "../../shell/commands";
import { useAdmin } from "../../shell/context";
import { Banner, Button, Input, SensitiveInput } from "../../shell/kumo";
import { AdminCode, AdminCopy, AdminDataTable, AdminForm, AdminPageHeader, AdminSection, AdminStatus, formatDate, useAdminToast } from "../../shell/ui";

type Enrollment = { totpURI: string; backupCodes: string[] };
const levelLabel = { password: "Password only", mfa: "Multi-factor", phishing_resistant: "Phishing-resistant (passkey)" } as const;

/**
 * The operator's own factors. Better Auth owns the protocols (TOTP, WebAuthn);
 * this view is the enrollment surface. Secrets appear once, at enrollment,
 * and are never retrievable again.
 */
export default function AccountSecurityView() {
  const { session, environment } = useAdmin();
  const client = useQueryClient();
  const toast = useAdminToast();
  const account = useQuery({ queryKey: ["admin", environment, "account-security"], queryFn: async () => {
    const [current, passkeys] = await Promise.all([authClient().getSession(), authClient().passkey.listUserPasskeys()]);
    return { twoFactorEnabled: Boolean((current.data?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled), passkeys: (passkeys.data ?? []) as Array<{ id: string; name?: string | null; deviceType: string; backedUp: boolean; createdAt: string | Date }> };
  } });
  const [password, setPassword] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [code, setCode] = useState("");
  const [passkeyName, setPasskeyName] = useState("");
  const [error, setError] = useState<string>();
  const refresh = async () => { await client.invalidateQueries({ queryKey: ["admin", environment, "account-security"] }); await client.invalidateQueries({ queryKey: sessionQueryKey }); };
  const attempt = async (label: string, work: () => Promise<{ error?: { message?: string } | null } | undefined | null>) => {
    setError(undefined);
    const result = await work();
    if (result?.error) { setError(result.error.message ?? `${label} failed`); return false; }
    toast.success(label); await refresh(); return true;
  };
  const addPasskey = () => void attempt("Passkey added", () => authClient().passkey.addPasskey({ name: passkeyName.trim() || `${session.operator.name}'s passkey` }) as never).then((ok) => { if (ok) setPasskeyName(""); });
  useAdminCommands({ "account-security.add-passkey": { run: addPasskey } });
  const secret = enrollment ? new URL(enrollment.totpURI).searchParams.get("secret") ?? "" : "";
  const assurance = session.assurance;
  return <>
    <AdminPageHeader title="Account security" description="Your sign-in factors. Sensitive platform actions require recent, verified evidence: a password locally; a second factor in deployed environments; a passkey to grant platform roles or start support sessions." />
    <AdminSection title="This session">
      {assurance ? <dl className="grid gap-2 text-sm sm:grid-cols-3">
        <div><dt className="text-kumo-subtle">Assurance</dt><dd><AdminStatus variant={assurance.level === "password" ? "warning" : "success"}>{levelLabel[assurance.level]}</AdminStatus></dd></div>
        <div><dt className="text-kumo-subtle">Method</dt><dd>{assurance.method}</dd></div>
        <div><dt className="text-kumo-subtle">Verified</dt><dd>{formatDate(assurance.verifiedAt)}</dd></div>
      </dl> : <Banner variant="alert" size="sm" description="No assurance evidence is recorded for this session. Sign in again before sensitive actions." />}
    </AdminSection>
    {error && <Banner className="mb-4" variant="error" size="sm" description={error} />}
    <AdminSection title="Authenticator app (TOTP)" description="Time-based codes from an authenticator app, with single-use backup codes."
      actions={account.data?.twoFactorEnabled ? <AdminStatus variant="success">enabled</AdminStatus> : <AdminStatus variant="neutral">not enabled</AdminStatus>}>
      {enrollment ? <div className="flex flex-col gap-3">
        <p className="text-sm">Add this key to your authenticator app, then enter the code it shows. It will not be shown again.</p>
        <p className="text-sm">Setup key: <AdminCopy value={secret} label="setup key" /></p>
        <details className="text-xs text-kumo-subtle"><summary className="cursor-pointer">otpauth URI</summary><AdminCode>{enrollment.totpURI}</AdminCode></details>
        <div className="rounded-lg bg-kumo-recessed p-3 ring ring-kumo-hairline">
          <p className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">Backup codes: store them now</p>
          <ul className="mt-1 grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-5">{enrollment.backupCodes.map((backup) => <li key={backup}>{backup}</li>)}</ul>
        </div>
        <AdminForm label="Verify authenticator" className="flex items-end gap-2" onSubmit={() => void attempt("Authenticator enabled", () => authClient().twoFactor.verifyTotp({ code: code.trim() }) as never).then((ok) => { if (ok) { setEnrollment(undefined); setCode(""); } })}>
          <Input label="Authentication code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
          <Button type="submit" variant="primary" disabled={!code.trim()}>Verify and enable</Button>
        </AdminForm>
      </div> : <AdminForm label={account.data?.twoFactorEnabled ? "Disable authenticator" : "Enable authenticator"} className="flex flex-wrap items-end gap-2"
        onSubmit={() => {
          if (account.data?.twoFactorEnabled) void attempt("Authenticator disabled", () => authClient().twoFactor.disable({ password }) as never).then(() => setPassword(""));
          else void authClient().twoFactor.enable({ password }).then((result) => { setPassword(""); if (result.error) setError(result.error.message ?? "Could not start enrollment"); else setEnrollment(result.data as Enrollment); });
        }}>
        <SensitiveInput label="Confirm your password" autoComplete="current-password" value={password} onChange={(event: { target: { value: string } }) => setPassword(event.target.value)} />
        <Button type="submit" variant={account.data?.twoFactorEnabled ? "secondary-destructive" : "primary"} disabled={!password}>{account.data?.twoFactorEnabled ? "Disable" : "Set up authenticator"}</Button>
      </AdminForm>}
    </AdminSection>
    <AdminSection title="Passkeys" description="Phishing-resistant sign-in with a platform authenticator or security key. Press p to add one."
      actions={<span className="flex items-end gap-2"><Input aria-label="Passkey name" placeholder="Name (optional)" value={passkeyName} onChange={(event) => setPasskeyName(event.target.value)} /><Button variant="primary" onClick={addPasskey}>Add passkey</Button></span>}>
      {(account.data?.passkeys.length ?? 0) === 0 ? <p className="text-sm text-kumo-subtle">No passkeys registered.</p> : <AdminDataTable caption="Passkeys" rows={account.data!.passkeys} rowKey={(row) => row.id} rowLabel={(row) => row.name ?? "passkey"}
        rowActions={(row) => [{ label: "Remove passkey", destructive: true, run: () => void attempt("Passkey removed", () => authClient().passkey.deletePasskey({ id: row.id }) as never) }]}
        columns={[
          { header: "Name", cell: (row) => row.name ?? "Passkey" },
          { header: "Type", cell: (row) => `${row.deviceType}${row.backedUp ? " · synced" : ""}` },
          { header: "Added", cell: (row) => formatDate(String(row.createdAt)) },
        ]} />}
    </AdminSection>
  </>;
}
