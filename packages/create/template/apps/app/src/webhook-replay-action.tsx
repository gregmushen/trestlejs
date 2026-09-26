export type ReplayUnavailableReason = "not_failed" | "payload_expired" | "resolved" | "endpoint_inactive" | "provider_unavailable" | "replay_pending" | "provenance_expired";

export type ReplayEligibility = { id: string; replayable: boolean; replayUnavailableReason: ReplayUnavailableReason | null };

const explanations: Record<Exclude<ReplayUnavailableReason, "not_failed">, string> = {
  replay_pending: "A replay is already queued.",
  resolved: "A replay of this message has succeeded.",
  payload_expired: "The payload is no longer retained, so this delivery cannot be replayed.",
  endpoint_inactive: "Activate this endpoint before replaying.",
  provider_unavailable: "Webhook delivery is unavailable in this environment.",
  provenance_expired: "The source event is older than the 14-day replay window or is no longer retained, so this delivery cannot be replayed.",
};

/** Replay for a failed delivery. The server computes eligibility and still
 * refuses an ineligible replay; this only keeps the action from being offered. */
export function DeliveryReplayAction({ delivery, pending, onReplay }: { delivery: ReplayEligibility; pending: boolean; onReplay: () => void }) {
  const reason = delivery.replayUnavailableReason;
  if (reason === "not_failed") return null;
  const explanationId = `replay-reason-${delivery.id}`;
  return <>
    <button type="button" className="mt-3 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
      disabled={!delivery.replayable || pending} aria-describedby={reason ? explanationId : undefined} onClick={onReplay}>
      {pending ? "Queuing replay…" : "Replay failed delivery"}
    </button>
    {reason && <p id={explanationId} className="mt-2 text-sm text-slate-600">{explanations[reason]}</p>}
  </>;
}
