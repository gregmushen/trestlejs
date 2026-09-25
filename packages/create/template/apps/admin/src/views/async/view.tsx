import { api, type DeadLetter } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useConfirmAction, type ConfirmConfig } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate } from "../../shell/context";
import { Grid } from "../../shell/kumo";
import { AdminCode, AdminDataTable, AdminPageHeader, AdminQueryState, AdminSection, AdminStat, formatDate } from "../../shell/ui";
import { useViewSearch } from "../../shell/url-state";

export default function AsyncView() {
  const { can } = useAdmin();
  const invalidate = useInvalidate();
  const [search] = useViewSearch<{ selected?: string }>();
  const state = useAdminQuery(["async"], api.async);
  const selected = state.data?.dead.find((row) => row.id === search.selected);
  const confirm = useConfirmAction();
  const redrive = (row: DeadLetter): ConfirmConfig => ({ title: "Redrive dead letter", confirmLabel: "Redrive", scope: [`Return ${row.event} (${row.id}) to the pending queue`], onConfirm: (reason) => api.redrive(row.id, reason), onDone: () => void invalidate("async") });
  useAdminCommands({
    "async.redrive": { enabled: Boolean(selected) && can("platform.outbox.redrive"), ...(selected ? { target: selected.id } : {}), run: () => { if (selected) confirm.open(redrive(selected)); } },
    "async.refresh": { run: () => void state.refetch() },
  });
  return <>
    <AdminPageHeader title="Async operations" description="Transactional outbox, queue delivery, and dead letters. Errors are categorized and redacted; redrive is idempotent and audited." />
    <AdminQueryState query={state}>{(data) => <>
      <Grid variant="4up" gap="base" className="mb-6">
        <AdminStat label="Pending" value={data.outbox.pending} /><AdminStat label="Leased" value={data.outbox.leased} />
        <AdminStat label="Succeeded" value={data.outbox.succeeded} variant="success" /><AdminStat label="Dead" value={data.outbox.dead} variant={data.outbox.dead ? "destructive" : "success"} />
      </Grid>
      <AdminSection title="Dead letters">
        {data.dead.length === 0 ? <p className="text-sm text-kumo-subtle">No dead-lettered messages.</p> : <AdminDataTable caption="Dead letters" selectable rows={data.dead} rowKey={(row) => row.id} rowLabel={(row) => row.event}
          rowActions={(row) => can("platform.outbox.redrive") ? [{ label: "Redrive", hotkey: "r", run: () => confirm.open(redrive(row)) }] : []}
          columns={[
            { header: "Event", cell: (row) => <><AdminCode>{row.event}</AdminCode><p className="text-xs text-kumo-subtle">{row.id}</p></> },
            { header: "Attempts", cell: (row) => row.attempts },
            { header: "Last error", cell: (row) => row.lastErrorCategory },
            { header: "Available", cell: (row) => formatDate(row.availableAt) },
          ]} />}
      </AdminSection>
    </>}</AdminQueryState>
    {confirm.dialog}
  </>;
}
