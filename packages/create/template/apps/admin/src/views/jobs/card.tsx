import { api } from "../../api";
import { useAdminQuery } from "../../shell/context";
import { AdminQueryState, AdminStatus } from "../../shell/ui";
import { engineLabel } from "./engines";

export default function JobsEngineCard() {
  const state = useAdminQuery(["jobs"], api.jobs);
  return <AdminQueryState query={state}>{(data) => <p className="text-sm">{data.runtime === null
    ? <><AdminStatus variant="neutral">unknown</AdminStatus> The Worker has not reported its engine yet.</>
    : <><AdminStatus variant={data.supportStatus === "supported" ? "success" : "warning"}>{data.supportStatus}</AdminStatus> {engineLabel(data.runtime)}, {String(data.dispatch.pending)} pending.</>}</p>}</AdminQueryState>;
}
