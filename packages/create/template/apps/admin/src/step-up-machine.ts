import { networkErrorMessage, stepUpRequirement, type AssuranceLevel } from "./step-up";

/**
 * The step-up dialog's pure parts, kept out of React so they can be tested
 * without a DOM: the form's stage reducer, the retry-once runner for Better
 * Auth calls, and the shell's hold decision.
 */

/** `stage` is where the operator is; `busy` is a request in flight, during which submit and Cancel are disabled. */
export type StepUpFormState = Readonly<{ stage: "password" | "code"; busy: boolean; error: string | undefined }>;
export type StepUpFormEvent =
  | { type: "submit" }
  | { type: "needs-code" }
  | { type: "failed"; error: string }
  | { type: "rejected"; error: string }
  | { type: "verified" };

export const initialStepUpForm = (notice?: string): StepUpFormState => ({ stage: "password", busy: false, error: notice });

export function stepUpFormReducer(state: StepUpFormState, event: StepUpFormEvent): StepUpFormState {
  switch (event.type) {
    // A new attempt clears the previous error or notice.
    case "submit": return { ...state, busy: true, error: undefined };
    case "needs-code": return { stage: "code", busy: false, error: undefined };
    // A wrong password or code (or a network error) keeps the operator where they were.
    case "failed": return { ...state, busy: false, error: event.error };
    // The verification worked but cannot be used (another account, or no second factor): start over.
    case "rejected": return { stage: "password", busy: false, error: event.error };
    // Stays busy while the caller retries the action.
    case "verified": return { ...state, busy: true, error: undefined };
  }
}

export type StepUpOutcome<T> = { kind: "done"; result: T } | { kind: "cancelled" } | { kind: "failed"; error: string };
/** Opens the step-up dialog; resolves true once verified, false when cancelled or unmounted. */
export type AskStepUp = (required: AssuranceLevel) => Promise<boolean>;

export const stepUpBusyMessage = "Finish the verification that is already open first.";
export const stepUpTooWeakMessage = "That verification was not strong enough for this change. Try another method.";

/**
 * Runs a Better Auth call; on a 428 asks for step-up once, then retries once.
 * Never throws: a network failure becomes a `failed` outcome. Only one
 * verification can be open at a time; a second call that needs one is refused.
 */
export function createStepUpRunner(ask: AskStepUp) {
  let asking = false;
  const attempt = async <T,>(work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
    try { return { ok: true, value: await work() }; } catch { return { ok: false }; }
  };
  return async function withStepUp<T extends { error?: unknown } | null | undefined>(work: () => Promise<T>): Promise<StepUpOutcome<T>> {
    const first = await attempt(work);
    if (!first.ok) return { kind: "failed", error: networkErrorMessage };
    const required = stepUpRequirement(first.value?.error);
    if (!required) return { kind: "done", result: first.value };
    if (asking) return { kind: "failed", error: stepUpBusyMessage };
    asking = true;
    let verified: boolean;
    try { verified = await ask(required); } catch { verified = false; } finally { asking = false; }
    if (!verified) return { kind: "cancelled" };
    const second = await attempt(work);
    if (!second.ok) return { kind: "failed", error: networkErrorMessage };
    if (stepUpRequirement(second.value?.error)) return { kind: "failed", error: stepUpTooWeakMessage };
    return { kind: "done", result: second.value };
  };
}

/** The shell keeps the app (and an open step-up dialog) mounted through a 401 only while a step-up holds it and a session was loaded. */
export const shouldHoldShell = (steppingUp: boolean, hasSession: boolean): boolean => steppingUp && hasSession;
