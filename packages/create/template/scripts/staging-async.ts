export type StagingAsyncEventState = {
  eventId: string;
  outboxStatus: string;
  inboxStatus: string | null;
};

export async function waitForStagingAsyncEvent(
  readState: () => Promise<StagingAsyncEventState | null>,
  options: {
    timeoutMs?: number;
    pollMs?: number;
    now?: () => number;
    pause?: (ms: number) => Promise<void>;
  } = {},
): Promise<StagingAsyncEventState> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const pollMs = options.pollMs ?? 2_000;
  const now = options.now ?? Date.now;
  const pause = options.pause ?? (async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (timeoutMs < 0 || pollMs <= 0) throw new Error("Invalid staging async polling interval");
  const deadline = now() + timeoutMs;

  while (true) {
    const state = await readState();
    if (state?.outboxStatus === "dead") throw new Error("The staging event reached the outbox dead-letter state");
    if (state?.outboxStatus === "succeeded" && state.inboxStatus === "completed") return state;
    if (now() >= deadline) throw new Error("The staging event did not complete through the Queue consumer before the deadline");
    await pause(Math.min(pollMs, Math.max(0, deadline - now())));
  }
}
