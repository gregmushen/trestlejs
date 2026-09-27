import { api } from "../../api";
import { useAdminQuery } from "../../shell/context";
import { AdminQueryState, AdminStatus } from "../../shell/ui";

export default function EmailSequencesCard() {
  const state = useAdminQuery(["email-sequences"], api.emailSequences);
  return <AdminQueryState query={state}>{(data) => {
    const total = (key: "active" | "failed" | "suppressed") => data.sequences.reduce((sum, row) => sum + row[key], 0);
    const sends = data.sequences.reduce((sum, row) => sum + row.sends.last24h, 0);
    return <p className="text-sm">{data.sequences.length === 0 ? <><AdminStatus variant="neutral">idle</AdminStatus> No sequence has started a run yet.</>
      : <><AdminStatus variant={total("failed") ? "warning" : "success"}>{`${String(total("active"))} active`}</AdminStatus> {String(sends)} sent in 24 hours, {String(total("suppressed"))} suppressed, {String(total("failed"))} failed.</>}</p>;
  }}</AdminQueryState>;
}
