import { Button } from "../../shell/kumo";

const explanations: Record<string, string> = {
  payload_expired: "Payload no longer retained",
  endpoint_inactive: "Endpoint is not active",
  replay_pending: "A replay is already queued",
  resolved: "A replay has already succeeded",
  provenance_expired: "Source event is outside the 14-day replay window or no longer retained",
};

/** Why a failed delivery cannot be replayed, for the operator. */
export function replayUnavailableExplanation(reason: string): string {
  return explanations[reason] ?? reason.replaceAll("_", " ");
}

/**
 * The replay action for one failed delivery. Eligibility comes from the server
 * read model; the server still refuses an ineligible replay, so this only keeps
 * operators from being offered an action that cannot succeed.
 */
export function ReplayCell(props: { row: { id: string; replayable?: boolean; replayUnavailableReason?: string | null }; canManage: boolean; onReplay: () => void }) {
  const reason = props.row.replayable ? null : props.row.replayUnavailableReason ?? null;
  const explanationId = `replay-reason-${props.row.id}`;
  const explanation = reason ? <span id={explanationId} className="text-xs text-kumo-subtle">{replayUnavailableExplanation(reason)}</span> : null;
  if (!props.canManage) return explanation;
  return <span className="flex items-center gap-2">
    <Button size="sm" variant="ghost" disabled={!props.row.replayable} aria-describedby={reason ? explanationId : undefined} onClick={props.onReplay}>Replay</Button>
    {explanation}
  </span>;
}
