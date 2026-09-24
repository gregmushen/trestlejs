import { useSyncExternalStore } from "react";

/**
 * Shared step-up state. Once a password step-up reaches the code prompt the
 * old session cookie has expired, so the shell pauses its session poll and
 * keeps the app mounted until the step-up finishes; otherwise the dialog, the
 * action, and its reason would be lost to the sign-in screen. The notice
 * explains a sign-out that a step-up caused.
 */
type State = Readonly<{ active: number; notice: string | null }>;

/** Better Auth's two-factor challenge cookie lives 10 minutes (twoFactorCookieMaxAge default, 600s); a hold never outlives it. */
export const twoFactorChallengeMs = 10 * 60_000;

let state: State = { active: 0, notice: null };
const listeners = new Set<() => void>();
const set = (next: State) => { state = next; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/**
 * Holds the shell for a step-up whose session has ended. Call the returned
 * function when it ends (success, cancel, or unmount); calling it again is a
 * no-op. After `timeoutMs` the hold releases itself and `onTimeout` runs.
 */
export function beginStepUp(timeoutMs = twoFactorChallengeMs, onTimeout?: () => void): () => void {
  set({ ...state, active: state.active + 1 });
  let ended = false;
  const end = () => { if (ended) return; ended = true; clearTimeout(timer); set({ ...state, active: state.active - 1 }); };
  const timer = setTimeout(() => { if (ended) return; end(); onTimeout?.(); }, timeoutMs);
  return end;
}

export const stepUpInProgress = (): boolean => state.active > 0;

/** Shown once on the sign-in screen after a step-up ended the session. */
export function setSignInNotice(notice: string | null): void { set({ ...state, notice }); }
export const signInNotice = (): string | null => state.notice;

/** Test support: forget every hold and notice. */
export function resetStepUpState(): void { set({ active: 0, notice: null }); }

export function useStepUpInProgress(): boolean {
  return useSyncExternalStore(subscribe, stepUpInProgress, stepUpInProgress);
}
export function useSignInNotice(): string | null {
  return useSyncExternalStore(subscribe, signInNotice, signInNotice);
}
