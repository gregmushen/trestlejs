import { useState } from "react";

import { api, errorMessage } from "../../api";
import type { JobsPlan, JobsStatus, JobsTargetInput } from "../../main-backend";
import type { useConfirmAction } from "../../shell/ConfirmAction";
import { Banner, Button, Checkbox, Input, Select } from "../../shell/kumo";
import { AdminCode, AdminSection, AdminStatus } from "../../shell/ui";
import { engineLabel, engineLabels, hostingLabels } from "./engines";

const hostingsFor = (runtime: string): string[] => runtime === "cloudflare" ? ["cloudflare"] : ["cloud", "self-hosted"];

/** Set or missing, with the CLI command that sets it. Secrets are never edited from admin. */
export function JobsCredentials(props: { credentials: JobsStatus["credentials"] }) {
  if (!props.credentials.length) return <p className="text-sm text-kumo-subtle">This engine needs no Worker secrets.</p>;
  return <ul className="space-y-1.5 text-sm">{props.credentials.map((credential) => <li key={credential.name} className="flex flex-wrap items-center gap-2">
    <AdminCode>{credential.name}</AdminCode>
    <AdminStatus variant={credential.present ? "success" : credential.present === null ? "neutral" : "destructive"}>{credential.present ? "set" : credential.present === null ? "unknown" : "missing"}</AdminStatus>
    {!credential.present && <span className="text-kumo-subtle">Set it with <AdminCode>{credential.command}</AdminCode>, then redeploy the Worker.</span>}
  </li>)}</ul>;
}

/**
 * Change the engine, hosting, or location. Review runs the plan (no write);
 * confirming applies it as an override with a reason and step-up, at the
 * override version that was reviewed.
 */
export function JobsEditPanel(props: { data: JobsStatus; confirm: ReturnType<typeof useConfirmAction>; onChanged: () => void }) {
  const { data } = props;
  const [draft, setDraft] = useState<JobsTargetInput>({ runtime: data.runtime ?? "cloudflare", hosting: data.hosting ?? "cloudflare", endpoint: data.endpoint ?? "", project: data.project ?? "" });
  const [plan, setPlan] = useState<JobsPlan | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string>();
  const change = (next: Partial<JobsTargetInput>) => { setDraft((current) => ({ ...current, ...next })); setPlan(null); setAcknowledged(false); };
  const review = async () => {
    setReviewing(true); setError(undefined);
    try { setPlan(await api.planJobs(draft)); } catch (caught) { setError(errorMessage(caught)); } finally { setReviewing(false); }
  };
  const apply = (reviewed: JobsPlan) => props.confirm.open({
    title: reviewed.kind === "switch" ? `Switch jobs to ${engineLabel(reviewed.target.runtime)}` : "Change the jobs engine settings",
    confirmLabel: reviewed.kind === "switch" ? "Switch engine" : "Apply",
    scope: [
      `${engineLabel(reviewed.current.runtime)} (${reviewed.current.hosting}) → ${engineLabel(reviewed.target.runtime)} (${reviewed.target.hosting})`,
      ...(reviewed.target.endpoint ? [`Endpoint ${reviewed.target.endpoint}`] : []),
      ...(reviewed.target.project ? [`Project ${reviewed.target.project}`] : []),
      `${String(reviewed.dispatch.pending)} pending and ${String(reviewed.dispatch.unconsumed)} unconsumed events`,
    ],
    onConfirm: (reason) => api.setJobs({ ...reviewed.target, expectedVersion: reviewed.overrideVersion, acknowledgeExperimental: acknowledged }, reason),
    onDone: () => { setPlan(null); props.onChanged(); },
    successMessage: reviewed.kind === "switch" ? "Engine switched; the Worker picks it up within 30 seconds" : "Settings applied",
  });
  const runtime = draft.runtime;
  return <AdminSection title="Change engine" description="Review shows the plan and writes nothing. Confirming overrides the deployed configuration for this environment until you revert it.">
    <div className="grid gap-3 sm:grid-cols-2">
      <Select label="Engine" hideLabel={false} value={runtime} onValueChange={(value) => { const next = String(value ?? "cloudflare"); change({ runtime: next, hosting: hostingsFor(next)[0]!, ...(next === "trigger" ? {} : { project: "" }) }); }}>
        {Object.entries(engineLabels).map(([key, label]) => <Select.Option key={key} value={key} disabled={!data.available.includes(key)}>{data.available.includes(key) ? label : `${label} (not installed)`}</Select.Option>)}
      </Select>
      <Select label="Hosting" hideLabel={false} value={draft.hosting} onValueChange={(value) => change({ hosting: String(value ?? "") })}>
        {hostingsFor(runtime).map((hosting) => <Select.Option key={hosting} value={hosting}>{hostingLabels[hosting] ?? hosting}</Select.Option>)}
      </Select>
      {draft.hosting === "self-hosted" && <Input label="Endpoint" placeholder="https://jobs.example.com" value={draft.endpoint ?? ""} onChange={(event) => change({ endpoint: event.target.value })} />}
      {runtime === "trigger" && <Input label="Project reference" placeholder="proj_…" value={draft.project ?? ""} onChange={(event) => change({ project: event.target.value })} />}
    </div>
    <div className="mt-4 flex gap-2"><Button variant="secondary" loading={reviewing} onClick={() => void review()}>{runtime === data.runtime && draft.hosting === data.hosting ? "Review change" : "Review switch"}</Button></div>
    {error && <Banner className="mt-3" variant="error" size="sm" description={error} />}
    {plan && <div className="mt-4 space-y-4 text-sm">
      <p><AdminStatus variant={plan.kind === "switch" ? "warning" : "info"}>{plan.kind}</AdminStatus> {engineLabel(plan.current.runtime)} → {engineLabel(plan.target.runtime)} · {String(plan.dispatch.pending)} pending, {String(plan.dispatch.unconsumed)} unconsumed, {String(plan.dispatch.dead)} dead</p>
      {plan.problems.length > 0 && <Banner variant="error" size="sm" title="This change cannot be applied yet" description={<ul className="list-disc pl-4">{plan.problems.map((problem) => <li key={problem.code + problem.message}>{problem.message}</li>)}</ul>} />}
      <div><p className="mb-1 font-medium">Credentials</p><JobsCredentials credentials={plan.credentials} /></div>
      <div><p className="mb-1 font-medium">Steps</p><ol className="list-decimal space-y-1 pl-5">{plan.steps.map((step) => <li key={step}>{step}</li>)}</ol></div>
      <div><p className="mb-1 font-medium">Rollback</p>{plan.rollback.map((line) => <p key={line} className="text-kumo-subtle">{line}</p>)}</div>
      {plan.experimental && <label className="flex items-center gap-2"><Checkbox checked={acknowledged} onCheckedChange={(on) => setAcknowledged(Boolean(on))} aria-label="Acknowledge experimental engine" />{engineLabel(plan.target.runtime)} is experimental in Trestle. I have read the steps and accept the risk.</label>}
      <Button variant="primary" disabled={!plan.allowed || (plan.experimental && !acknowledged)} onClick={() => apply(plan)}>Confirm</Button>
    </div>}
  </AdminSection>;
}
