import { useHotkeys } from "@tanstack/react-hotkeys";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { StepUpRequired, errorMessage, reasonSchema, type ActionFailure, type ActionOutcome } from "../api";
import type { AssuranceLevel } from "../step-up";
import { formatHotkey } from "./commands";
import { useAdmin } from "./context";
import { Banner, Button, Dialog, Textarea } from "./kumo";
import { StepUpForm } from "./StepUp";
import { useAdminToast } from "./ui";

export type ConfirmConfig = Readonly<{
  title: string;
  /** What will change, shown before the operator commits, e.g. "Revoke 1 API key tr_live_7Ks9…". */
  scope: readonly string[];
  description?: ReactNode;
  confirmLabel: string;
  /** Destructive actions confirm with Mod+Shift+Enter and use danger styling. */
  destructive?: boolean;
  /** Extra inputs shown above the reason (for example a profile and duration). */
  fields?: ReactNode;
  onConfirm: (reason: string) => Promise<unknown>;
  onDone?: (result: unknown) => void;
  /** Toast shown on success; failures stay in the dialog. */
  successMessage?: string;
}>;

const outcomeOf = (value: unknown): ActionOutcome | undefined =>
  value && typeof value === "object" && ("failed" in value || "succeeded" in value) ? value as ActionOutcome : undefined;

/**
 * The sensitive-action flow: scope preview, a typed audit reason, step-up
 * re-authentication, and partial-failure reporting. Buttons and hotkeys open
 * the same dialog through `open()`; no key chord can skip the reason,
 * permission, freshness, or step-up checks, which the server also enforces.
 */
export function useConfirmAction() {
  const { environment } = useAdmin();
  const toast = useAdminToast();
  const [config, setConfig] = useState<ConfirmConfig | null>(null);
  const [reason, setReason] = useState("");
  const [stage, setStage] = useState<"reason" | "step-up" | "working" | "partial">("reason");
  const [required, setRequired] = useState<AssuranceLevel>("password");
  // Each challenge remounts the step-up form; a repeat after verifying explains why.
  const [challenge, setChallenge] = useState<{ count: number; notice?: string }>({ count: 0 });
  const steppedUp = useRef(false);
  const [error, setError] = useState<string>();
  const [failures, setFailures] = useState<readonly ActionFailure[]>([]);
  const [succeeded, setSucceeded] = useState<readonly string[]>([]);
  const origin = useRef<HTMLElement | null>(null);

  const open = useCallback((next: ConfirmConfig) => {
    // A hotkey fires with focus on the page; return focus to the active row it acted on.
    const focused = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    origin.current = focused ?? document.querySelector<HTMLElement>("tr[data-active]");
    steppedUp.current = false;
    setReason(""); setStage("reason"); setError(undefined); setFailures([]); setSucceeded([]);
    setConfig(next);
  }, []);
  const close = useCallback(() => {
    setConfig(null);
    // Focus returns to the control (or row) that opened the dialog.
    const target = origin.current;
    window.setTimeout(() => target?.isConnected && target.focus(), 0);
  }, []);

  const run = async () => {
    if (!config) return;
    const parsed = reasonSchema.safeParse(reason);
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? "A reason is required"); return; }
    setError(undefined);
    setStage("working");
    try {
      const result = await config.onConfirm(parsed.data);
      const outcome = outcomeOf(result);
      config.onDone?.(result);
      if (outcome?.failed?.length) { setFailures(outcome.failed); setSucceeded(outcome.succeeded ?? []); setStage("partial"); return; }
      toast.success(config.successMessage ?? `${config.confirmLabel}: done`);
      close();
    } catch (caught) {
      if (caught instanceof StepUpRequired) {
        setRequired(caught.required);
        setChallenge((current) => ({ count: current.count + 1, ...(steppedUp.current ? { notice: "That verification was not strong enough for this action. Try another method." } : {}) }));
        setStage("step-up"); setError(undefined); return;
      }
      setError(errorMessage(caught));
      setStage("reason");
    }
  };
  // After a successful step-up the action runs again with the same reason; the server checks the new session.
  const retry = async () => { steppedUp.current = true; await run(); };
  // The step-up form submits itself on Enter; the chords confirm the reason stage.
  const submit = () => { if (stage === "reason") void run(); };
  const destructive = config?.destructive ?? false;
  useHotkeys([
    { hotkey: "Mod+Enter", callback: (event) => { if (!destructive) { event.preventDefault(); submit(); } }, options: { enabled: config !== null, ignoreInputs: false } },
    { hotkey: "Mod+Shift+Enter", callback: (event) => { if (destructive) { event.preventDefault(); submit(); } }, options: { enabled: config !== null, ignoreInputs: false } },
  ]);

  const dialog = <Dialog.Root open={config !== null} onOpenChange={(next) => { if (!next) close(); }}>
    {config && <Dialog size="lg" className="p-6">
      <Dialog.Title>{config.title}</Dialog.Title>
      {config.description && <Dialog.Description render={(props) => <div {...props} className="mt-1 text-sm text-kumo-subtle" />}>{config.description}</Dialog.Description>}
      {environment === "production" && <Banner className="mt-3" variant="error" size="sm" title="Production" description="This changes the production environment." />}
      <div className="mt-4 rounded-lg bg-kumo-recessed p-3 ring ring-kumo-hairline">
        <p className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">This will change</p>
        <ul className="mt-1 space-y-0.5 text-sm">{config.scope.map((line) => <li key={line} className="font-mono text-kumo-default">{line}</li>)}</ul>
      </div>
      {stage === "partial" ? <div className="mt-4" role="alert">
        <Banner variant="alert" title={`Completed with failures: ${succeeded.length} succeeded, ${failures.length} failed`} />
        <ul className="mt-2 space-y-1 text-sm">{failures.map((failure) => <li key={failure.target} className="rounded bg-kumo-recessed px-3 py-1.5 text-kumo-danger"><span className="font-mono">{failure.target}</span>: {failure.message}</li>)}</ul>
        <div className="mt-5 flex justify-end"><Button variant="secondary" onClick={close}>Close</Button></div>
      </div> : stage === "step-up" ? <StepUpForm key={challenge.count} required={required} onVerified={retry} onCancel={close} {...(challenge.notice ? { notice: challenge.notice } : {})} />
      : <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); void run(); }}>
        {config.fields}
        <Textarea label="Reason (recorded in the audit log)" autoFocus required maxLength={500} rows={3} value={reason} onChange={(event: { target: { value: string } }) => setReason(event.target.value)} placeholder="Ticket reference and justification" />
        {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-kumo-subtle">{formatHotkey(destructive ? "Mod+Shift+Enter" : "Mod+Enter")} to confirm</span>
          <span className="flex gap-2">
            <Button variant="secondary" onClick={close}>Cancel</Button>
            <Button type="submit" variant={destructive ? "destructive" : "primary"} loading={stage === "working"} disabled={stage === "working" || !reason.trim()}>{config.confirmLabel}</Button>
          </span>
        </div>
      </form>}
    </Dialog>}
  </Dialog.Root>;

  return { open, close, dialog, isOpen: config !== null };
}

/** A visible trigger for a confirmation; pair it with the same `open()` your command handler calls. */
export function ConfirmButton(props: ConfirmConfig & { label: ReactNode; disabled?: boolean; variant?: "primary" | "secondary" | "destructive" | "secondary-destructive" }) {
  const confirm = useConfirmAction();
  const { label, disabled, variant, ...config } = props;
  return <>
    <Button variant={variant ?? (config.destructive ? "secondary-destructive" : "secondary")} disabled={disabled ?? false} onClick={(event) => { event.stopPropagation(); confirm.open(config); }}>{label}</Button>
    {confirm.dialog}
  </>;
}
