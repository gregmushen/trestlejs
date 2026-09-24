import { useSyncExternalStore } from "react";

/**
 * Shared step-up state. While a TOTP step-up waits at the code prompt the old
 * session cookie has already expired, so the shell pauses its session poll and
 * keeps the app mounted until the step-up finishes; otherwise the dialog, the
 * action, and its reason would be lost to the sign-in screen. The notice
 * explains a sign-out that a step-up caused.
 */
type State = Readonly<{ active: number; notice: string | null }>;

let state: State = { active: 0, notice: null };
const listeners = new Set<() => void>();
const set = (next: State) => { state = next; for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Marks a step-up as in progress; call the returned function exactly once when it ends (success, failure, or cancel). */
export function beginStepUp(): () => void {
  set({ ...state, active: state.active + 1 });
  let ended = false;
  return () => { if (ended) return; ended = true; set({ ...state, active: state.active - 1 }); };
}

export const stepUpInProgress = (): boolean => state.active > 0;

/** Shown once on the sign-in screen after a step-up ended the session. */
export function setSignInNotice(notice: string | null): void { set({ ...state, notice }); }
export const signInNotice = (): string | null => state.notice;

export function useStepUpInProgress(): boolean {
  return useSyncExternalStore(subscribe, stepUpInProgress, stepUpInProgress);
}
export function useSignInNotice(): string | null {
  return useSyncExternalStore(subscribe, signInNotice, signInNotice);
}
