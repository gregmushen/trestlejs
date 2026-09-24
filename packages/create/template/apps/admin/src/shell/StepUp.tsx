import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { sessionQueryKey } from "../api";
import { reauthenticateWithPasskey, reauthenticateWithPassword, verifySecondFactor, type ReauthResult } from "../auth-client";
import { stepUpMethods, stepUpRequirement, type AssuranceLevel } from "../step-up";
import { useAdmin } from "./context";
import { Button, Dialog, Input, SensitiveInput } from "./kumo";

const intro: Record<AssuranceLevel, ReactNode> = {
  phishing_resistant: "This requires a passkey verified in the last 15 minutes.",
  mfa: "This requires a recent sign-in with a second factor. Confirm your password, then enter your authenticator code, or use a passkey.",
  password: "This requires a recent sign-in. Confirm your password to continue.",
};

/**
 * Re-authenticates the operator after a 428 step-up challenge, offering only
 * the paths that can reach `required`. Each path creates a fresh session whose
 * assurance the server records and checks again when the caller retries.
 */
export function StepUpForm(props: { required: AssuranceLevel; onVerified: () => void | Promise<void>; onCancel: () => void; notice?: string }) {
  const { session } = useAdmin();
  const queryClient = useQueryClient();
  const methods = stepUpMethods(props.required);
  const [stage, setStage] = useState<"password" | "code" | "working">("password");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeKind, setCodeKind] = useState<"totp" | "backup">("totp");
  const [error, setError] = useState<string | undefined>(props.notice);
  // A password sign-in replaces the session cookie, so the shell re-reads the session either way.
  const refreshSession = () => void queryClient.invalidateQueries({ queryKey: sessionQueryKey });
  const finish = async (result: ReauthResult, retryStage: "password" | "code", viaPassword: boolean) => {
    if ("needsCode" in result) { setStage("code"); setError(undefined); return; }
    if (!result.ok) { setError(result.error); setStage(retryStage); return; }
    setCode("");
    refreshSession();
    // Without an authenticator, a password reaches password assurance only.
    if (viaPassword && props.required !== "password") { setError("This account has no authenticator app enrolled, so a password alone cannot satisfy this. Use a passkey, or set up an authenticator in Account security."); setStage("password"); return; }
    await props.onVerified();
  };
  const withPassword = async () => {
    setStage("working");
    const result = await reauthenticateWithPassword(session.operator.email, password);
    setPassword("");
    await finish(result, "password", true);
  };
  const withCode = async () => { setStage("working"); await finish(await verifySecondFactor(code, codeKind), "code", false); };
  const withPasskey = async () => { setStage("working"); await finish(await reauthenticateWithPasskey(), "password", false); };
  const cancel = () => { refreshSession(); props.onCancel(); };
  const working = stage === "working";

  if (stage === "code") return <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void withCode(); }}>
    <p className="text-sm text-kumo-default">Enter the {codeKind === "totp" ? "6-digit code from your authenticator app" : "backup code"} for <strong>{session.operator.email}</strong>.</p>
    <Input label={codeKind === "totp" ? "Authentication code" : "Backup code"} autoFocus autoComplete="one-time-code" inputMode={codeKind === "totp" ? "numeric" : "text"} value={code} onChange={(event) => setCode(event.target.value)} />
    {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
    <div className="flex items-center justify-between gap-2">
      <Button variant="ghost" size="sm" onClick={() => setCodeKind(codeKind === "totp" ? "backup" : "totp")}>{codeKind === "totp" ? "Use a backup code" : "Use an authenticator code"}</Button>
      <span className="flex gap-2"><Button variant="secondary" onClick={cancel}>Cancel</Button><Button type="submit" variant="primary" disabled={!code.trim()}>Verify and continue</Button></span>
    </div>
  </form>;
  return <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); if (methods.password) void withPassword(); }}>
    <p className="text-sm text-kumo-default">{intro[props.required]} You are signed in as <strong>{session.operator.email}</strong>.</p>
    {methods.password && <SensitiveInput label="Password" autoFocus autoComplete="current-password" value={password} onChange={(event: { target: { value: string } }) => setPassword(event.target.value)} />}
    {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      {methods.passkey ? <Button variant={methods.password ? "ghost" : "primary"} autoFocus={!methods.password} loading={working && !methods.password} disabled={working} onClick={() => void withPasskey()}>Verify with a passkey</Button> : <span />}
      <span className="flex gap-2">
        <Button variant="secondary" onClick={cancel}>Cancel</Button>
        {methods.password && <Button type="submit" variant="primary" loading={working} disabled={working || !password}>Confirm and continue</Button>}
      </span>
    </div>
  </form>;
}

/**
 * For Better Auth calls the admin Worker guards with step-up (factor
 * management): runs `work`, and on a 428 asks the operator to re-authenticate
 * in a dialog, then retries once. Resolves to undefined when they cancel.
 */
export function useStepUp() {
  const [pending, setPending] = useState<{ required: AssuranceLevel } | null>(null);
  const settle = useRef<((verified: boolean) => void) | null>(null);
  const resolve = useCallback((verified: boolean) => { settle.current?.(verified); settle.current = null; setPending(null); }, []);
  const withStepUp = useCallback(async <T extends { error?: unknown } | null | undefined>(work: () => Promise<T>): Promise<T | undefined> => {
    const first = await work();
    const required = stepUpRequirement(first?.error);
    if (!required) return first;
    const verified = await new Promise<boolean>((done) => { settle.current = done; setPending({ required }); });
    return verified ? await work() : undefined;
  }, []);
  const dialog = <Dialog.Root open={pending !== null} onOpenChange={(next) => { if (!next) resolve(false); }}>
    {pending && <Dialog size="lg" className="p-6">
      <Dialog.Title>Confirm it is you</Dialog.Title>
      <StepUpForm required={pending.required} onVerified={() => resolve(true)} onCancel={() => resolve(false)} />
    </Dialog>}
  </Dialog.Root>;
  return { withStepUp, dialog };
}
