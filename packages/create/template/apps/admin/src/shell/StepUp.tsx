import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";

import { sessionQueryKey } from "../api";
import { reauthenticateWithPasskey, reauthenticateWithPassword, stepUpIdentity, verifySecondFactor, type ReauthResult } from "../auth-client";
import { confirmStepUpIdentity, stepUpMethods, type AssuranceLevel } from "../step-up";
import { createStepUpRunner, initialStepUpForm, stepUpFormReducer } from "../step-up-machine";
import { beginStepUp, setSignInNotice, twoFactorChallengeMs } from "../step-up-state";
import { useAdmin } from "./context";
import { Button, Dialog, Input, SensitiveInput } from "./kumo";
import { useAdminToast } from "./ui";

const intro: Record<AssuranceLevel, ReactNode> = {
  phishing_resistant: "This requires a passkey verified in the last 15 minutes.",
  mfa: "This requires a recent sign-in with a second factor. Confirm your password, then enter your authenticator code, or use a passkey.",
  password: "This requires a recent sign-in. Confirm your password to continue.",
};
const cancelledNotice = "Verification cancelled. Sign in again to continue.";
const noSecondFactor = "This account has no authenticator app enrolled, so a password alone cannot satisfy this. Use a passkey, or set up an authenticator in Account security.";

/**
 * Re-authenticates the operator after a 428 step-up challenge, offering only
 * the paths that can reach `required`. Each path creates a fresh session whose
 * assurance the server records and checks again when the caller retries, and
 * that session must belong to the same operator. From the code prompt (which
 * runs without a live session) until the step-up ends, it holds the shell's
 * session poll, for at most the life of Better Auth's two-factor challenge.
 * Nothing continues once the form is gone: a result that arrives after the
 * dialog closed never runs the action.
 */
export function StepUpForm(props: { required: AssuranceLevel; onVerified: () => void | Promise<void>; onCancel: () => void; notice?: string }) {
  const { session } = useAdmin();
  // The operator who opened the dialog; a session refresh mid-step-up never changes whose identity is checked.
  const operator = useRef(session.operator).current;
  const toast = useAdminToast();
  const queryClient = useQueryClient();
  const methods = stepUpMethods(props.required);
  const [state, dispatch] = useReducer(stepUpFormReducer, props.notice, initialStepUpForm);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [codeKind, setCodeKind] = useState<"totp" | "backup">("totp");
  const live = useRef(true);
  const hold = useRef<(() => void) | null>(null);
  // Set while the operator has no live session (a code prompt, or another account signed out); shown on sign-in once the form is gone.
  const sessionEnded = useRef<string | null>(null);
  const cancel = useRef(props.onCancel);
  cancel.current = props.onCancel;
  const invalidateSession = useCallback(() => void queryClient.invalidateQueries({ queryKey: sessionQueryKey }), [queryClient]);
  const release = () => { hold.current?.(); hold.current = null; };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      hold.current?.(); hold.current = null;
      if (sessionEnded.current) { setSignInNotice(sessionEnded.current); invalidateSession(); }
    };
  }, [invalidateSession]);

  const finish = async (result: ReauthResult, method: "password" | "code" | "passkey") => {
    if ("needsCode" in result) {
      // The old session is gone; if the dialog already closed, only the sign-in screen is left to explain it.
      if (!live.current) { setSignInNotice(cancelledNotice); invalidateSession(); return; }
      sessionEnded.current = cancelledNotice;
      hold.current ??= beginStepUp(twoFactorChallengeMs, () => { hold.current = null; if (live.current) cancel.current(); });
      dispatch({ type: "needs-code" });
      return;
    }
    if (!result.ok) { if (live.current) dispatch({ type: "failed", error: result.error }); return; }
    const identity = await confirmStepUpIdentity(operator.id, method === "passkey" ? "passkey" : "password", stepUpIdentity);
    release();
    if (!identity.ok && !identity.signedOut) {
      // Still signed in as another account: close the dialog and say so; nothing is retried.
      sessionEnded.current = null;
      toast.failure("Step-up stopped", new Error(identity.error));
      if (live.current) cancel.current();
      invalidateSession();
      return;
    }
    if (!identity.ok) {
      // Signed out: stop holding, and let the shell move to sign-in with the reason.
      if (!live.current) { setSignInNotice(identity.error); invalidateSession(); return; }
      sessionEnded.current = identity.error;
      dispatch({ type: "rejected", error: identity.error });
      invalidateSession();
      return;
    }
    sessionEnded.current = null;
    invalidateSession();
    if (!live.current) return;
    // Without an authenticator, a password reaches password assurance only.
    if (method === "password" && props.required !== "password") { dispatch({ type: "rejected", error: noSecondFactor }); return; }
    dispatch({ type: "verified" });
    await props.onVerified();
  };
  const withPassword = async () => {
    dispatch({ type: "submit" });
    const result = await reauthenticateWithPassword(operator.email, password);
    setPassword("");
    await finish(result, "password");
  };
  const withCode = async () => { dispatch({ type: "submit" }); await finish(await verifySecondFactor(code, codeKind), "code"); };
  const withPasskey = async () => { dispatch({ type: "submit" }); await finish(await reauthenticateWithPasskey(), "passkey"); };
  const { busy, error } = state;

  if (state.stage === "code") return <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); if (!busy) void withCode(); }}>
    <p className="text-sm text-kumo-default">Enter the {codeKind === "totp" ? "6-digit code from your authenticator app" : "backup code"} for <strong>{operator.email}</strong>.</p>
    <Input label={codeKind === "totp" ? "Authentication code" : "Backup code"} autoFocus autoComplete="one-time-code" inputMode={codeKind === "totp" ? "numeric" : "text"} value={code} onChange={(event) => setCode(event.target.value)} />
    {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
    <div className="flex items-center justify-between gap-2">
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setCodeKind(codeKind === "totp" ? "backup" : "totp")}>{codeKind === "totp" ? "Use a backup code" : "Use an authenticator code"}</Button>
      <span className="flex gap-2"><Button variant="secondary" disabled={busy} onClick={() => props.onCancel()}>Cancel</Button><Button type="submit" variant="primary" loading={busy} disabled={busy || !code.trim()}>Verify and continue</Button></span>
    </div>
  </form>;
  return <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); if (methods.password && !busy) void withPassword(); }}>
    <p className="text-sm text-kumo-default">{intro[props.required]} You are signed in as <strong>{operator.email}</strong>.</p>
    {methods.password && <SensitiveInput label="Password" autoFocus autoComplete="current-password" value={password} onChange={(event: { target: { value: string } }) => setPassword(event.target.value)} />}
    {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
    <div className="flex flex-wrap items-center justify-between gap-2">
      {methods.passkey ? <Button variant={methods.password ? "ghost" : "primary"} autoFocus={!methods.password} loading={busy && !methods.password} disabled={busy} onClick={() => void withPasskey()}>Verify with a passkey</Button> : <span />}
      <span className="flex gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => props.onCancel()}>Cancel</Button>
        {methods.password && <Button type="submit" variant="primary" loading={busy} disabled={busy || !password}>Confirm and continue</Button>}
      </span>
    </div>
  </form>;
}

/**
 * For Better Auth calls the admin Worker guards with step-up (factor
 * management): runs `work`, and on a 428 asks the operator to re-authenticate
 * in a dialog, then retries once. Resolves to an outcome and never throws; a
 * pending verification is cancelled when the caller unmounts.
 */
export function useStepUp() {
  const [pending, setPending] = useState<{ required: AssuranceLevel } | null>(null);
  const settle = useRef<((verified: boolean) => void) | null>(null);
  const resolve = useCallback((verified: boolean) => { const done = settle.current; settle.current = null; setPending(null); done?.(verified); }, []);
  useEffect(() => () => { settle.current?.(false); settle.current = null; }, []);
  const withStepUp = useMemo(() => createStepUpRunner((required) => new Promise<boolean>((done) => { settle.current = done; setPending({ required }); })), []);
  const dialog = <Dialog.Root open={pending !== null} onOpenChange={(next) => { if (!next) resolve(false); }}>
    {pending && <Dialog size="lg" className="p-6">
      <Dialog.Title>Confirm it is you</Dialog.Title>
      <StepUpForm required={pending.required} onVerified={() => resolve(true)} onCancel={() => resolve(false)} />
    </Dialog>}
  </Dialog.Root>;
  return { withStepUp, dialog };
}
