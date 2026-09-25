import { api } from "../../api";
import { useAdminQuery } from "../../shell/context";
import { AdminQueryState, AdminStatus } from "../../shell/ui";

export default function DeadLetterCard() {
  const state = useAdminQuery(["async"], api.async);
  return <AdminQueryState query={state}>{(data) => <p className="text-sm">{data.outbox.dead === 0 ? <><AdminStatus variant="success">clear</AdminStatus> No dead-lettered messages.</> : <><AdminStatus variant="destructive">{String(data.outbox.dead)}</AdminStatus> dead-lettered messages need review.</>}</p>}</AdminQueryState>;
}
