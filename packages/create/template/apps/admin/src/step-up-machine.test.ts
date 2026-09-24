import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SignInRequired, StepUpRequired, createAdminApi, onSignInRequired, toApiError } from "./api";
import { networkErrorMessage } from "./step-up";
import { createStepUpRunner, initialStepUpForm, shouldHoldShell, stepUpBusyMessage, stepUpFormReducer, stepUpTooWeakMessage } from "./step-up-machine";
import { beginStepUp, resetStepUpState, setSignInNotice, signInNotice, stepUpInProgress, twoFactorChallengeMs } from "./step-up-state";

const challenge = (required = "mfa") => ({ data: null, error: { status: 428, error: "step_up_required", required, message: "Re-authenticate" } });
const ok = <T,>(data: T) => ({ data, error: null });

beforeEach(() => resetStepUpState());
afterEach(() => vi.useRealTimers());

describe("step-up form reducer", () => {
  it("moves password → code → verified, staying busy while requests run and clearing errors on submit", () => {
    let state = initialStepUpForm("That verification was not strong enough");
    expect(state).toEqual({ stage: "password", busy: false, error: "That verification was not strong enough" });
    state = stepUpFormReducer(state, { type: "submit" });
    expect(state).toEqual({ stage: "password", busy: true, error: undefined });
    state = stepUpFormReducer(state, { type: "needs-code" });
    expect(state).toEqual({ stage: "code", busy: false, error: undefined });
    state = stepUpFormReducer(stepUpFormReducer(state, { type: "submit" }), { type: "failed", error: "Invalid code" });
    // A wrong code keeps the code prompt; it never flips back to the password form.
    expect(state).toEqual({ stage: "code", busy: false, error: "Invalid code" });
    state = stepUpFormReducer(stepUpFormReducer(state, { type: "submit" }), { type: "verified" });
    expect(state).toEqual({ stage: "code", busy: true, error: undefined });
  });

  it("starts over at the password form when a verification cannot be used", () => {
    const state = stepUpFormReducer({ stage: "code", busy: true, error: undefined }, { type: "rejected", error: "That passkey belongs to a different account" });
    expect(state).toEqual({ stage: "password", busy: false, error: "That passkey belongs to a different account" });
  });
});

describe("step-up runner", () => {
  it("passes results through without asking when no step-up is needed", async () => {
    const ask = vi.fn(async () => true);
    const outcome = await createStepUpRunner(ask)(async () => ok({ status: true }));
    expect(outcome).toEqual({ kind: "done", result: ok({ status: true }) });
    expect(ask).not.toHaveBeenCalled();
  });

  it("asks once at the required level and retries once", async () => {
    const ask = vi.fn(async () => true);
    const work = vi.fn().mockResolvedValueOnce(challenge("phishing_resistant")).mockResolvedValueOnce(ok({ status: true }));
    expect(await createStepUpRunner(ask)(work)).toEqual({ kind: "done", result: ok({ status: true }) });
    expect(ask).toHaveBeenCalledWith("phishing_resistant");
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("never retries when the operator cancels, including a cancel while a request was in flight", async () => {
    const work = vi.fn(async () => challenge());
    expect(await createStepUpRunner(async () => false)(work)).toEqual({ kind: "cancelled" });
    // The dialog unmounting mid-request settles its promise false (or rejects); either way the action does not run.
    expect(await createStepUpRunner(async () => { throw new Error("unmounted"); })(work)).toEqual({ kind: "cancelled" });
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("stops after a second 428 instead of looping", async () => {
    const ask = vi.fn(async () => true);
    const work = vi.fn(async () => challenge());
    expect(await createStepUpRunner(ask)(work)).toEqual({ kind: "failed", error: stepUpTooWeakMessage });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("turns a thrown request (a network failure) into a failed outcome", async () => {
    const offline = async () => { throw new TypeError("Failed to fetch"); };
    expect(await createStepUpRunner(async () => true)(offline)).toEqual({ kind: "failed", error: networkErrorMessage });
    const work = vi.fn().mockResolvedValueOnce(challenge()).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await createStepUpRunner(async () => true)(work)).toEqual({ kind: "failed", error: networkErrorMessage });
  });

  it("refuses a second verification while one is open, then allows the next", async () => {
    let settle: (verified: boolean) => void = () => undefined;
    const ask = vi.fn(() => new Promise<boolean>((done) => { settle = done; }));
    const run = createStepUpRunner(ask);
    const first = run(vi.fn().mockResolvedValueOnce(challenge()).mockResolvedValueOnce(ok(1)));
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(await run(async () => challenge())).toEqual({ kind: "failed", error: stepUpBusyMessage });
    // A call that needs no step-up is not blocked.
    expect(await run(async () => ok(2))).toEqual({ kind: "done", result: ok(2) });
    settle(true);
    expect(await first).toEqual({ kind: "done", result: ok(1) });
    const third = run(vi.fn().mockResolvedValueOnce(challenge()).mockResolvedValueOnce(ok(3)));
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(2));
    settle(true);
    expect(await third).toEqual({ kind: "done", result: ok(3) });
  });
});

describe("shell hold", () => {
  it("holds only while a step-up is in progress and a session was loaded", () => {
    expect(shouldHoldShell(true, true)).toBe(true);
    expect(shouldHoldShell(true, false)).toBe(false);
    expect(shouldHoldShell(false, true)).toBe(false);
  });

  it("counts overlapping holds and ends each exactly once", () => {
    const first = beginStepUp();
    const second = beginStepUp();
    first(); first();
    expect(stepUpInProgress()).toBe(true);
    second();
    expect(stepUpInProgress()).toBe(false);
  });

  it("releases a hold when Better Auth's two-factor challenge expires", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const end = beginStepUp(twoFactorChallengeMs, onTimeout);
    vi.advanceTimersByTime(twoFactorChallengeMs - 1);
    expect(stepUpInProgress()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(stepUpInProgress()).toBe(false);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    end();
    expect(stepUpInProgress()).toBe(false);
    // An ended hold never times out later.
    const ended = beginStepUp(1_000, onTimeout);
    ended();
    vi.advanceTimersByTime(2_000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(twoFactorChallengeMs).toBe(600_000);
  });

  it("keeps a sign-in notice until cleared", () => {
    setSignInNotice("Verification cancelled. Sign in again to continue.");
    expect(signInNotice()).toMatch(/cancelled/u);
    resetStepUpState();
    expect(signInNotice()).toBeNull();
  });
});

describe("admin API 428", () => {
  it("reads the required level and treats an unknown one as the strongest", async () => {
    const response = (body: unknown) => new Response(JSON.stringify(body), { status: 428, headers: { "content-type": "application/json" } });
    const mfa = await toApiError(response({ error: "step_up_required", required: "mfa", message: "x" }));
    expect(mfa).toBeInstanceOf(StepUpRequired);
    expect((mfa as StepUpRequired).required).toBe("mfa");
    expect(((await toApiError(response({ error: "step_up_required", required: "retina" }))) as StepUpRequired).required).toBe("phishing_resistant");
  });

  it("sends a session that is below the minimum sign-in level back to sign-in, never to a step-up dialog", async () => {
    const body = { error: "step_up_required", required: "mfa", reason: "insufficient_level", scope: "session", message: "Sign in with your second factor or passkey" };
    const response = () => new Response(JSON.stringify(body), { status: 428, headers: { "content-type": "application/json" } });
    const error = await toApiError(response());
    expect(error).toBeInstanceOf(SignInRequired);
    expect(error).not.toBeInstanceOf(StepUpRequired);

    // Any admin API call that meets it notifies the shell, which re-reads the session and shows sign-in.
    const heard = vi.fn();
    const stop = onSignInRequired(heard);
    const client = createAdminApi({ fetch: async () => response() });
    await expect(client.request("GET", "overview")).rejects.toBeInstanceOf(SignInRequired);
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    await expect(client.request("GET", "overview")).rejects.toBeInstanceOf(SignInRequired);
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
