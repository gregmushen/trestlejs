import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { adminQueryKey, sessionQueryKey, stepUpDue } from "../../api";
import { authClient } from "../../auth-client";
import { authErrorMessage, networkErrorMessage } from "../../step-up";
import { useAdminCommands } from "../../shell/commands";
import { useAdmin, useNow } from "../../shell/context";
import { Banner, Button, Dialog, Input, SensitiveInput } from "../../shell/kumo";
import { useStepUp } from "../../shell/StepUp";
import { AdminCode, AdminCopy, AdminDataTable, AdminForm, AdminPageHeader, AdminSection, AdminStatus, formatDate, useAdminToast } from "../../shell/ui";

type Enrollment = { totpURI: string; backupCodes: string[] };
type Passkey = { id: string; name?: string | null; deviceType: string; backedUp: boolean; createdAt: string | Date };
type AuthResult = { data?: unknown; error?: unknown } | null | undefined;
/** The base32 setup key inside an otpauth URI, or empty when the URI cannot be read. */
const setupKey = (uri: string): string => { try { return new URL(uri).searchParams.get("secret") ?? ""; } catch { return ""; } };
const levelLabel = { password: "Password only", mfa: "Multi-factor", phishing_resistant: "Phishing-resistant (passkey)" } as const;

/**
 * The operator's own factors. Better Auth owns the protocols (TOTP, WebAuthn);
 * this view is the enrollment surface. Secrets appear once, at enrollment,
 * and are never retrievable again. The admin Worker asks for step-up at the
 * strongest factor the account already has before any factor changes.
 */
export default function AccountSecurityView() {
  const { session, scope } = useAdmin();
  const client = useQueryClient();
  const toast = useAdminToast();
  const now = useNow(30_000);
  const { withStepUp, dialog } = useStepUp();
  const accountKey = adminQueryKey(scope, "account-security");
  const account = useQuery({ queryKey: accountKey, queryFn: async () => {
    const [current, passkeys] = await Promise.all([authClient().getSession(), authClient().passkey.listUserPasskeys()]);
    if (passkeys.error) throw new Error(authErrorMessage(passkeys.error, "Could not load your passkeys"));
    return { twoFactorEnabled: Boolean((current.data?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled), passkeys: (passkeys.data ?? []) as Passkey[] };
  } });
  const [password, setPassword] = useState("");
  const [enrollment, setEnrollment] = useState<Enrollment>();
  const [code, setCode] = useState("");
  const [passkeyName, setPasskeyName] = useState("");
  const [error, setError] = useState<string>();
  // Regenerated backup codes are shown once, until the operator dismisses them.
  const [backupCodes, setBackupCodes] = useState<string[]>();
  const [removing, setRemoving] = useState<Passkey>();
  const refresh = async () => { await client.invalidateQueries({ queryKey: accountKey }); await client.invalidateQueries({ queryKey: sessionQueryKey }); };
  /** Runs a factor call through step-up; resolves to its data, or undefined when it failed or the operator cancelled. */
  const attempt = async <T,>(label: string, work: () => Promise<AuthResult>): Promise<T | undefined> => {
    setError(undefined);
    try {
      const outcome = await withStepUp(work);
      if (outcome.kind === "cancelled") return undefined;
      if (outcome.kind === "failed") { setError(outcome.error); return undefined; }
      if (outcome.result?.error) { setError(authErrorMessage(outcome.result.error, `${label} failed`)); return undefined; }
      await refresh().catch(() => undefined);
      return (outcome.result?.data ?? {}) as T;
    } catch {
      setError(networkErrorMessage);
      return undefined;
    }
  };
  const addPasskey = () => void attempt("Add passkey", () => authClient().passkey.addPasskey({ name: passkeyName.trim() || `${session.operator.name}'s passkey` })).then((done) => { if (done) { toast.success("Passkey added"); setPasskeyName(""); } });
  useAdminCommands({ "account-security.add-passkey": { run: addPasskey } });
  const enableOrDisable = () => {
    const confirmed = password;
    setPassword("");
    if (account.data?.twoFactorEnabled) void attempt("Disable authenticator", () => authClient().twoFactor.disable({ password: confirmed })).then((done) => { if (done) toast.success("Authenticator disabled"); });
    else void attempt<Enrollment>("Set up authenticator", () => authClient().twoFactor.enable({ password: confirmed })).then((started) => { if (started) setEnrollment(started); });
  };
  // Completes enrollment; never trusts the device, so later step-ups still ask for a code.
  const verifyEnrollment = () => void attempt("Verify authenticator", () => authClient().twoFactor.verifyTotp({ code: code.trim(), trustDevice: false })).then((done) => { if (done) { toast.success("Authenticator enabled"); setEnrollment(undefined); setCode(""); } });
  const regenerateBackupCodes = () => {
    const confirmed = password;
    setPassword("");
    void attempt<{ backupCodes?: string[] }>("Regenerate backup codes", () => authClient().twoFactor.generateBackupCodes({ password: confirmed })).then((done) => { if (done?.backupCodes) { setBackupCodes(done.backupCodes); toast.success("Backup codes regenerated"); } });
  };
  const removePasskey = (row: Passkey) => { setRemoving(undefined); void attempt("Remove passkey", () => authClient().passkey.deletePasskey({ id: row.id })).then((done) => { if (done) toast.success("Passkey removed"); }); };
  const secret = enrollment ? setupKey(enrollment.totpURI) : "";
  const assurance = session.assurance;
  const passkeys = account.data?.passkeys ?? [];
  return <>
    <AdminPageHeader title="Account security" description="Your sign-in factors. Sensitive platform actions require recent, verified evidence: a password locally, a second factor in deployed environments, and a passkey to grant or revoke platform roles. Changing a factor requires the strongest factor you already have." />
    <AdminSection title="This session">
      {assurance ? <dl className="grid gap-2 text-sm sm:grid-cols-4">
        <div><dt className="text-kumo-subtle">Assurance</dt><dd><AdminStatus variant={assurance.level === "password" ? "warning" : "success"}>{levelLabel[assurance.level]}</AdminStatus></dd></div>
        <div><dt className="text-kumo-subtle">Method</dt><dd>{assurance.method}</dd></div>
        <div><dt className="text-kumo-subtle">Verified</dt><dd>{formatDate(assurance.verifiedAt)}</dd></div>
        <div><dt className="text-kumo-subtle">Sensitive actions</dt><dd>{stepUpDue(session, now) ? <AdminStatus variant="warning">re-authentication needed</AdminStatus> : <>fresh until {formatDate(session.stepUpRequiredAfter)}</>}</dd></div>
      </dl> : <Banner variant="alert" size="sm" description="No assurance evidence is recorded for this session. You will be asked to re-authenticate before any sensitive action." />}
    </AdminSection>
    {error && <Banner className="mb-4" variant="error" size="sm" description={error} />}
    {account.error && <Banner className="mb-4" variant="error" size="sm" description={account.error.message} />}
    <AdminSection title="Authenticator app (TOTP)" description="Time-based codes from an authenticator app, with single-use backup codes."
      actions={account.data && (account.data.twoFactorEnabled ? <AdminStatus variant="success">enabled</AdminStatus> : <AdminStatus variant="neutral">not enabled</AdminStatus>)}>
      {enrollment ? <div className="flex flex-col gap-3">
        <p className="text-sm">Add this key to your authenticator app, then enter the code it shows. It will not be shown again.</p>
        <p className="text-sm">Setup key: <AdminCopy value={secret} label="setup key" /></p>
        <details className="text-xs text-kumo-subtle"><summary className="cursor-pointer">otpauth URI</summary><AdminCode>{enrollment.totpURI}</AdminCode></details>
        <div className="rounded-lg bg-kumo-recessed p-3 ring ring-kumo-hairline">
          <p className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">Backup codes: store them now</p>
          <ul className="mt-1 grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-5">{enrollment.backupCodes.map((backup) => <li key={backup}>{backup}</li>)}</ul>
        </div>
        <AdminForm label="Verify authenticator" className="flex items-end gap-2" onSubmit={verifyEnrollment}>
          <Input label="Authentication code" autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
          <Button type="submit" variant="primary" disabled={!code.trim()}>Verify and enable</Button>
        </AdminForm>
      </div> : <>
        {backupCodes && <div className="mb-3 rounded-lg bg-kumo-recessed p-3 ring ring-kumo-hairline">
          <p className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">New backup codes: store them now. The old ones no longer work.</p>
          <ul className="mt-1 grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-5">{backupCodes.map((backup) => <li key={backup}>{backup}</li>)}</ul>
          <Button className="mt-2" size="sm" variant="secondary" onClick={() => setBackupCodes(undefined)}>I have stored them</Button>
        </div>}
        <AdminForm label={account.data?.twoFactorEnabled ? "Disable authenticator" : "Enable authenticator"} className="flex flex-wrap items-end gap-2" onSubmit={enableOrDisable}>
          <SensitiveInput label="Confirm your password" autoComplete="current-password" value={password} onChange={(event: { target: { value: string } }) => setPassword(event.target.value)} />
          <Button type="submit" variant={account.data?.twoFactorEnabled ? "secondary-destructive" : "primary"} disabled={!password || !account.data}>{account.data?.twoFactorEnabled ? "Disable" : "Set up authenticator"}</Button>
          {account.data?.twoFactorEnabled && <Button variant="secondary" disabled={!password} onClick={regenerateBackupCodes}>Regenerate backup codes</Button>}
        </AdminForm>
      </>}
    </AdminSection>
    <AdminSection title="Passkeys" description="Phishing-resistant sign-in with a platform authenticator or security key. Press p to add one."
      actions={<span className="flex items-end gap-2"><Input aria-label="Passkey name" placeholder="Name (optional)" value={passkeyName} onChange={(event) => setPasskeyName(event.target.value)} /><Button variant="primary" onClick={addPasskey}>Add passkey</Button></span>}>
      {passkeys.length > 0 && <p className="mb-3 text-sm text-kumo-subtle">If you lose every passkey, another platform operator has to recover this account. Register a second one as a backup.</p>}
      {account.isPending ? <p className="text-sm text-kumo-subtle">Loading your passkeys…</p> : passkeys.length === 0 ? <p className="text-sm text-kumo-subtle">No passkeys registered.</p> : <AdminDataTable caption="Passkeys" rows={passkeys} rowKey={(row) => row.id} rowLabel={(row) => row.name ?? "passkey"}
        rowActions={(row) => [{ label: "Remove passkey", destructive: true, run: () => setRemoving(row) }]}
        columns={[
          { header: "Name", cell: (row) => row.name ?? "Passkey" },
          { header: "Type", cell: (row) => `${row.deviceType}${row.backedUp ? " · synced" : ""}` },
          { header: "Added", cell: (row) => formatDate(String(row.createdAt)) },
        ]} />}
    </AdminSection>
    <Dialog.Root open={removing !== undefined} onOpenChange={(next) => { if (!next) setRemoving(undefined); }}>
      {removing && <Dialog size="sm" className="p-6">
        <Dialog.Title>Remove passkey</Dialog.Title>
        <p className="mt-2 text-sm text-kumo-default">{passkeys.length <= 1
          ? <>This is your last passkey. Removing it lowers this account to {account.data?.twoFactorEnabled ? "authenticator codes" : "a password"} as its strongest factor.</>
          : <>Remove {removing.name ?? "this passkey"}? It will no longer sign you in.</>}</p>
        <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={() => setRemoving(undefined)}>Cancel</Button><Button variant="destructive" onClick={() => removePasskey(removing)}>Remove passkey</Button></div>
      </Dialog>}
    </Dialog.Root>
    {dialog}
  </>;
}
