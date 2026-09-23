import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";

import { api, type StreamDefinitionJson, type StreamWindowJson, type StreamDetail, type StreamPreview, type StreamSummary } from "../../api";
import { type useConfirmAction } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery } from "../../shell/context";
import { Banner, Button, Checkbox, Input, Select, Textarea } from "../../shell/kumo";
import { OrganizationPicker, UserPicker } from "../../shell/pickers";
import { AdminCreateDialog, AdminDetailDrawer, AdminFacts, keyFromName } from "../../shell/resource";
import { AdminCode, AdminDataTable, AdminEmpty, AdminQueryState, AdminSection, AdminStatus, formatDate } from "../../shell/ui";

type Confirm = ReturnType<typeof useConfirmAction>;
type Row = StreamSummary & { source: "stream" | "code" };
type Sample = Record<string, string>;

const variableHint = (definition: StreamDefinitionJson) => definition.inputs.length ? definition.inputs.map((input) => `{{${input.name}}}`).join(" ") : "declare inputs to use {{variables}}";

/** Sample values typed per declared input, so previews and tests validate exactly as sends do. */
function sampleData(definition: StreamDefinitionJson, sample: Sample): Record<string, string | number | boolean | null> {
  return Object.fromEntries(definition.inputs.flatMap((input) => {
    const raw = sample[input.name] ?? "";
    if (raw === "") return [];
    return [[input.name, input.type === "number" ? Number(raw) : input.type === "boolean" ? raw === "true" : raw]];
  }));
}

function WindowFields(props: { label: string; value: StreamWindowJson; onChange: (value: StreamWindowJson) => void; disabled: boolean }) {
  return <div className="flex flex-col gap-2">
    <label className="flex items-center gap-2 text-sm"><Checkbox checked={Boolean(props.value)} disabled={props.disabled} aria-label={props.label} onCheckedChange={(on) => props.onChange(on ? { key: "", windowMinutes: 60 } : null)} />{props.label}</label>
    {props.value && <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
      <Input label={`${props.label} key`} placeholder="{{invoiceId}}" disabled={props.disabled} value={props.value.key} onChange={(event) => props.onChange({ ...props.value!, key: event.target.value })} />
      <Input label="Window (minutes)" type="number" min={1} max={10080} disabled={props.disabled} value={String(props.value.windowMinutes)} onChange={(event) => props.onChange({ ...props.value!, windowMinutes: Number(event.target.value) || 0 })} />
    </div>}
  </div>;
}

/** The single mutable draft. Saving never affects sends; only publishing does. */
function DraftEditor(props: { value: StreamDefinitionJson; onChange: (value: StreamDefinitionJson) => void; disabled: boolean }) {
  const value = props.value;
  const set = (patch: Partial<StreamDefinitionJson>) => props.onChange({ ...value, ...patch });
  const route = (channel: "in_app" | "email", patch: { enabled?: boolean; default?: boolean }) => {
    const routes = { ...value.routes };
    const current = routes[channel];
    if (patch.enabled === false) delete routes[channel];
    else routes[channel] = { default: patch.default ?? current?.default ?? true };
    set({ routes });
  };
  return <div className="flex flex-col">
    <AdminSection title="Inputs" description="The typed data callers pass to ctx.notifications.send. Sends with missing, mistyped, or unknown fields are refused.">
      <div className="flex flex-col gap-2">
        {value.inputs.map((input, index) => <div key={index} className="grid items-end gap-2 sm:grid-cols-[1fr_9rem_auto_auto]">
          <Input label="Input name" value={input.name} disabled={props.disabled} onChange={(event) => set({ inputs: value.inputs.map((entry, at) => at === index ? { ...entry, name: event.target.value } : entry) })} />
          <Select label="Type" hideLabel={false} value={input.type} disabled={props.disabled} onValueChange={(next) => set({ inputs: value.inputs.map((entry, at) => at === index ? { ...entry, type: String(next) as typeof entry.type } : entry) })}>
            {["string", "number", "boolean", "url"].map((type) => <Select.Option key={type} value={type}>{type}</Select.Option>)}
          </Select>
          <label className="flex items-center gap-2 pb-2 text-sm"><Checkbox checked={input.required} disabled={props.disabled} aria-label={`${input.name || "input"} required`} onCheckedChange={(on) => set({ inputs: value.inputs.map((entry, at) => at === index ? { ...entry, required: Boolean(on) } : entry) })} />Required</label>
          <Button variant="ghost" shape="square" aria-label={`Remove ${input.name || "input"}`} icon={<TrashIcon />} disabled={props.disabled} onClick={() => set({ inputs: value.inputs.filter((_entry, at) => at !== index) })} />
        </div>)}
        <div><Button variant="secondary" icon={<PlusIcon />} disabled={props.disabled || value.inputs.length >= 30} onClick={() => set({ inputs: [...value.inputs, { name: "", type: "string", required: false }] })}>Add input</Button></div>
      </div>
    </AdminSection>
    <AdminSection title="Recipients and routes">
      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset className="flex flex-col gap-2 text-sm"><legend className="mb-1 font-medium">Allowed recipients</legend>
          {([["user", "Individual members"], ["organization_role", "Everyone with an organization role"]] as const).map(([kind, label]) => <label key={kind} className="flex items-center gap-2">
            <Checkbox checked={value.recipients.includes(kind)} disabled={props.disabled} aria-label={label} onCheckedChange={(on) => set({ recipients: on ? [...new Set([...value.recipients, kind])] : value.recipients.filter((entry) => entry !== kind) })} />{label}</label>)}
        </fieldset>
        <fieldset className="flex flex-col gap-2 text-sm"><legend className="mb-1 font-medium">Delivery routes</legend>
          {([["in_app", "In-app inbox"], ["email", "Email"]] as const).map(([channel, label]) => <div key={channel} className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2"><Checkbox checked={Boolean(value.routes[channel])} disabled={props.disabled} aria-label={label} onCheckedChange={(on) => route(channel, { enabled: Boolean(on) })} />{label}</label>
            {value.routes[channel] && <label className="flex items-center gap-2 text-kumo-subtle"><Checkbox checked={value.routes[channel]!.default} disabled={props.disabled} aria-label={`${label} on by default`} onCheckedChange={(on) => route(channel, { default: Boolean(on) })} />on by default</label>}
          </div>)}
          <p className="text-xs text-kumo-subtle">Further channels appear here as the application adds them.</p>
        </fieldset>
        <Select label="Delivery strategy" hideLabel={false} value={value.strategy} disabled={props.disabled} onValueChange={(next) => set({ strategy: String(next) as StreamDefinitionJson["strategy"] })}>
          <Select.Option value="parallel">Parallel: every enabled route</Select.Option>
          <Select.Option value="fallback">Fallback: email only when the inbox is off</Select.Option>
        </Select>
        <Select label="Preference policy" hideLabel={false} value={value.policy} disabled={props.disabled} onValueChange={(next) => set({ policy: String(next) as StreamDefinitionJson["policy"] })}>
          <Select.Option value="user">Members choose</Select.Option>
          <Select.Option value="organization">Organization-controlled</Select.Option>
          <Select.Option value="mandatory">Mandatory (nobody opts out)</Select.Option>
        </Select>
      </div>
    </AdminSection>
    <AdminSection title="Templates" description={<>Values are inserted as plain text, never markup. Available: <AdminCode>{variableHint(value)}</AdminCode></>}>
      <div className="flex flex-col gap-3">
        <Input label="Title" value={value.templates.title} disabled={props.disabled} onChange={(event) => set({ templates: { ...value.templates, title: event.target.value } })} />
        <Textarea label="Body" rows={3} value={value.templates.body} disabled={props.disabled} onChange={(event: { target: { value: string } }) => set({ templates: { ...value.templates, body: event.target.value } })} />
        <Input label="Link (optional)" placeholder="/invoices/{{invoiceId}}" value={value.templates.link ?? ""} disabled={props.disabled} onChange={(event) => { const { link: _link, ...rest } = value.templates; set({ templates: event.target.value ? { ...rest, link: event.target.value } : rest }); }} />
      </div>
    </AdminSection>
    <AdminSection title="Grouping, deduplication, and scheduling">
      <div className="flex flex-col gap-4">
        <WindowFields label="Group repeats" value={value.grouping ?? null} disabled={props.disabled} onChange={(grouping) => set({ grouping })} />
        <WindowFields label="Deduplicate" value={value.dedupe ?? null} disabled={props.disabled} onChange={(dedupe) => set({ dedupe })} />
        <div className="grid gap-2 sm:grid-cols-2">
          <Input label="Delay before delivery (minutes)" type="number" min={0} max={10080} value={String(value.delayMinutes ?? 0)} disabled={props.disabled} onChange={(event) => set({ delayMinutes: Number(event.target.value) || 0 })} />
          <Input label="Email digest window (minutes, blank for none)" type="number" min={1} max={10080} value={value.digestMinutes ? String(value.digestMinutes) : ""} disabled={props.disabled} onChange={(event) => set({ digestMinutes: Number(event.target.value) || null })} />
        </div>
      </div>
    </AdminSection>
  </div>;
}

function PreviewAndTest(props: { type: string; definition: StreamDefinitionJson; version: number; dirty: boolean; canTest: boolean; confirm: Confirm; onSent: () => void }) {
  const [sample, setSample] = useState<Sample>({});
  const [preview, setPreview] = useState<StreamPreview | null>(null);
  const [organizationId, setOrganizationId] = useState("");
  const [userId, setUserId] = useState("");
  const data = sampleData(props.definition, sample);
  const run = async () => setPreview(await api.previewStream(props.type, { definition: props.definition, data }));
  const test = () => props.confirm.open({
    title: `Send a test of ${props.type}`, confirmLabel: "Send test", scope: [`version ${props.version}`, "one member receives it, titled [Test]", "it is never grouped or deduplicated and is recorded like any send"],
    onConfirm: (reason) => api.testStream(props.type, { organizationId, userId, version: props.version, data }, reason), onDone: props.onSent, successMessage: "Test notification queued",
  });
  return <AdminSection title="Preview and test" description="Previews render the editor's current values; nothing is stored or sent.">
    <div className="flex flex-col gap-3">
      {props.definition.inputs.length === 0 ? <p className="text-sm text-kumo-subtle">No inputs declared.</p> : <div className="grid gap-2 sm:grid-cols-2">
        {props.definition.inputs.map((input) => input.type === "boolean"
          ? <Select placeholder="unset" key={input.name} label={`${input.name} (sample)`} hideLabel={false} value={sample[input.name] ?? ""} onValueChange={(next) => setSample({ ...sample, [input.name]: String(next ?? "") })}><Select.Option value="">unset</Select.Option><Select.Option value="true">true</Select.Option><Select.Option value="false">false</Select.Option></Select>
          : <Input key={input.name} label={`${input.name || "input"} (sample)`} type={input.type === "number" ? "number" : "text"} value={sample[input.name] ?? ""} onChange={(event) => setSample({ ...sample, [input.name]: event.target.value })} />)}
      </div>}
      <div><Button variant="secondary" onClick={() => void run()}>Preview</Button></div>
      {preview && <div className="rounded-lg p-4 ring ring-kumo-hairline" aria-label="Rendered preview">
        <p className="font-medium">{preview.title || <span className="text-kumo-subtle">(empty title)</span>}</p>
        <p className="mt-1 whitespace-pre-wrap text-sm">{preview.body}</p>
        {preview.link && <p className="mt-1 text-xs text-kumo-subtle">Link: {preview.link}</p>}
        {preview.problems.length > 0 && <ul className="mt-2 list-disc pl-5 text-sm text-kumo-danger">{preview.problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>}
      </div>}
      {props.canTest && <div className="flex flex-col gap-2 border-t border-kumo-hairline pt-3">
        <p className="text-sm font-medium">Marked test delivery</p>
        {props.dirty && <p className="text-xs text-kumo-subtle">Save the draft first: tests send the saved version.</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          <OrganizationPicker value={organizationId} onChange={(id) => { setOrganizationId(id); setUserId(""); }} />
          <UserPicker label="Member" value={userId} organizationId={organizationId} onChange={setUserId} />
        </div>
        <div><Button variant="secondary" disabled={!organizationId || !userId || props.dirty} onClick={test}>Send test</Button></div>
      </div>}
    </div>
  </AdminSection>;
}

export function StreamDrawer(props: { type: string; open: boolean; onClose: () => void; confirm: Confirm; onChanged: () => void }) {
  const { can } = useAdmin();
  const manage = can("platform.notification_streams.manage");
  const detail = useAdminQuery(["notification-stream", props.type], () => api.notificationStream(props.type), { enabled: props.open });
  const [editing, setEditing] = useState<StreamDefinitionJson | null>(null);
  const [saved, setSaved] = useState<{ problems: string[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const data = detail.data;
  const draft = data?.draft ?? null;
  // The editor follows the stored draft until the operator changes something.
  useEffect(() => { setEditing(draft ? draft.definition : null); setSaved(null); }, [draft?.version, draft?.updatedAt]);
  const dirty = Boolean(editing && draft && JSON.stringify(editing) !== JSON.stringify(draft.definition));
  const archived = Boolean(data?.stream.archivedAt);
  const changed = () => { props.onChanged(); void detail.refetch(); };
  const save = async () => { setSaving(true); try { setSaved(await api.saveStreamDraft(props.type, editing!)); changed(); } finally { setSaving(false); } };
  const problems = saved?.problems ?? data?.problems ?? [];
  const actions = data && manage ? <>
    {draft && !archived && <Button variant="primary" disabled={dirty || problems.length > 0} onClick={() => props.confirm.open({
      title: `Publish ${data.stream.type} v${draft.version}`, confirmLabel: "Publish", scope: [data.active ? `v${data.active.version} is superseded; notifications already queued keep their recorded version` : "the stream becomes sendable", "published versions are immutable"],
      onConfirm: (reason) => api.publishStream(props.type, reason), onDone: changed, successMessage: "Stream published",
    })}>Publish</Button>}
    {!draft && !archived && <Button variant="secondary" onClick={() => props.confirm.open({ title: "Create a draft", confirmLabel: "Create draft", scope: [`copies v${data.active?.version ?? data.versions[0]?.version ?? 1} into a new draft`, "the active version keeps sending until you publish"], onConfirm: (reason) => api.createStreamDraft(props.type, reason), onDone: changed })}>Edit as new draft</Button>}
    {draft && data.versions.length > 1 && <Button variant="secondary" onClick={() => props.confirm.open({ title: `Discard draft v${draft.version}`, confirmLabel: "Discard draft", destructive: true, scope: ["the unpublished changes are removed", "published versions are unaffected"], onConfirm: (reason) => api.discardStreamDraft(props.type, reason), onDone: changed })}>Discard draft</Button>}
    <Button variant={archived ? "secondary" : "secondary-destructive"} onClick={() => props.confirm.open(archived
      ? { title: `Restore ${data.stream.type}`, confirmLabel: "Restore stream", scope: [data.active ? `v${data.active.version} becomes sendable again` : "the draft can be edited again"], onConfirm: (reason) => api.setStreamArchived(props.type, false, reason), onDone: changed }
      : { title: `Archive ${data.stream.type}`, confirmLabel: "Archive stream", destructive: true, scope: ["sends of this type fail visibly from now on", "every version and delivery record is kept; the type key is never reused"], onConfirm: (reason) => api.setStreamArchived(props.type, true, reason), onDone: changed })}>{archived ? "Restore" : "Archive"}</Button>
  </> : undefined;
  return <AdminDetailDrawer open={props.open} onClose={props.onClose} width="lg" title={data?.stream.name ?? props.type} subtitle={<AdminCode>{props.type}</AdminCode>} actions={actions}>
    <AdminQueryState query={detail}>{(loaded: StreamDetail) => <div className="flex flex-col">
      <div className="mb-6"><AdminFacts items={[
        ["Status", archived ? <AdminStatus key="s" variant="neutral">archived</AdminStatus> : loaded.active ? <AdminStatus key="s" variant="success">{`active v${loaded.active.version}`}</AdminStatus> : <AdminStatus key="s" variant="warning">unpublished</AdminStatus>],
        ["Draft", loaded.draft ? `v${loaded.draft.version}, saved ${formatDate(loaded.draft.updatedAt)}` : "none"],
        ["Description", loaded.stream.description || "—"],
        ["Created", `${formatDate(loaded.stream.createdAt)} by ${loaded.stream.createdBy}`],
        ...(archived ? [["Archived", `${formatDate(loaded.stream.archivedAt)} by ${loaded.stream.archivedBy ?? "—"}`] as const] : []),
        ["Send it", <AdminCode key="c">{`ctx.notifications.send({ type: "${loaded.stream.type}", recipient, data })`}</AdminCode>],
      ]} /></div>
      {editing && loaded.draft && <>
        {problems.length > 0 && <Banner className="mb-6" variant="alert" title={`Draft v${loaded.draft.version} cannot be published yet`} description={<ul className="list-disc pl-5">{problems.map((problem) => <li key={problem}>{problem}</li>)}</ul>} />}
        <DraftEditor value={editing} onChange={setEditing} disabled={!manage || archived} />
        {manage && !archived && <div className="mb-6 flex items-center justify-end gap-2">
          {dirty && <span className="text-sm text-kumo-subtle">Unsaved changes</span>}
          <Button variant="secondary" disabled={!dirty} onClick={() => setEditing(loaded.draft!.definition)}>Revert</Button>
          <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>Save draft</Button>
        </div>}
      </>}
      {!loaded.draft && loaded.active && <AdminSection title={`Version ${loaded.active.version} (published)`} description="Published versions are immutable. Edit as a new draft to change it.">
        <DraftEditor value={loaded.active.definition} onChange={() => undefined} disabled />
      </AdminSection>}
      {(editing ?? loaded.active?.definition) && <PreviewAndTest type={loaded.stream.type} definition={(editing ?? loaded.active!.definition)} version={(loaded.draft ?? loaded.active)!.version} dirty={dirty} canTest={manage && !archived} confirm={props.confirm} onSent={changed} />}
      <AdminSection title="Versions"><AdminDataTable caption="Stream versions" primary={false} rows={loaded.versions} rowKey={(row) => String(row.version)} columns={[
        { header: "Version", nowrap: true, cell: (row) => `v${row.version}` },
        { header: "State", nowrap: true, cell: (row) => <AdminStatus value={row.state}>{row.state}</AdminStatus> },
        { header: "Published", nowrap: true, cell: (row) => row.publishedAt ? `${formatDate(row.publishedAt)} by ${row.publishedBy ?? "—"}` : "—" },
        { header: "Routes", nowrap: true, priority: "low", cell: (row) => Object.keys(row.definition.routes).join(", ") || "—" },
      ]} /></AdminSection>
      <AdminSection title="Recent sends">{loaded.recent.length ? <AdminDataTable caption="Recent sends" primary={false} rows={loaded.recent} rowKey={(row) => row.id} columns={[
        { header: "Recipient", minWidth: "10rem", cell: (row) => <>{row.recipient.name}<p className="text-xs text-kumo-subtle">{row.organizationName}</p></> },
        { header: "Channels", cell: (row) => <span className="flex flex-wrap gap-1">{row.channels.map((channel) => <AdminStatus key={channel.id} value={channel.status}>{`${channel.channel}: ${channel.status}`}</AdminStatus>)}</span> },
        { header: "Created", nowrap: true, cell: (row) => formatDate(row.createdAt) },
      ]} /> : <AdminEmpty title="Nothing sent yet" />}</AdminSection>
      <AdminSection title="Audit">{loaded.audit.length ? <ul className="flex flex-col gap-1 text-sm">{loaded.audit.map((event) => <li key={event.id}>{formatDate(event.occurredAt)} <AdminCode>{event.name}</AdminCode> {event.actor}{event.reason ? `: ${event.reason}` : ""}</li>)}</ul> : <AdminEmpty title="No audit events" />}</AdminSection>
    </div>}</AdminQueryState>
  </AdminDetailDrawer>;
}

export function NewStreamDialog(props: { open: boolean; onClose: () => void; confirm: Confirm; onCreated: (type: string) => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("");
  const [typeTouched, setTypeTouched] = useState(false);
  const [description, setDescription] = useState("");
  useEffect(() => { if (props.open) { setName(""); setType(""); setTypeTouched(false); setDescription(""); } }, [props.open]);
  const suggested = typeTouched ? type : name.trim() ? `app.${keyFromName(name)}` : "";
  const valid = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/u.test(suggested);
  const submit = async () => {
    const input = { type: suggested, name: name.trim(), description: description.trim() };
    props.onClose();
    props.confirm.open({
      title: `Create ${input.type}`, confirmLabel: "Create stream", scope: [`type key ${input.type} is permanent and never reused`, "a draft v1 opens for editing; nothing sends until you publish"],
      onConfirm: (reason) => api.createNotificationStream(input, reason), onDone: () => props.onCreated(input.type),
    });
  };
  return <AdminCreateDialog open={props.open} onClose={props.onClose} title="New stream" submitLabel="Review and create" disabled={!name.trim() || !valid} onSubmit={submit}
    description="A stream is the contract application code sends by type. Its routes, templates, and policy are edited as drafts and published as immutable versions.">
    <Input label="Name" required value={name} onChange={(event) => setName(event.target.value)} />
    <Input label="Type key" required value={suggested} onChange={(event) => { setTypeTouched(true); setType(event.target.value); }} description="Lowercase and dotted, such as billing.invoice_ready. It cannot be changed later." />
    {suggested && !valid && <p className="text-sm text-kumo-danger">Use a dotted lowercase key such as billing.invoice_ready.</p>}
    <Textarea label="Description" rows={2} value={description} onChange={(event: { target: { value: string } }) => setDescription(event.target.value)} />
  </AdminCreateDialog>;
}

export function StreamsTable(props: { onSelect: (type: string) => void; showArchived: boolean }) {
  const list = useAdminQuery(["notification-streams"], api.notificationStreams);
  const rows = useMemo<Row[]>(() => !list.data ? [] : [
    ...list.data.streams.filter((stream) => props.showArchived || !stream.archivedAt).map((stream) => ({ ...stream, source: "stream" as const })),
    ...list.data.code.map((entry) => ({ type: entry.type, name: entry.name, description: entry.description, archivedAt: null, activeVersion: null, publishedAt: null, draftVersion: null, routes: entry.routes, policy: entry.mandatory.length ? "mandatory" : "user", source: "code" as const })),
  ], [list.data, props.showArchived]);
  return <AdminQueryState query={list} isEmpty={() => rows.length === 0} empty={{ title: "No streams yet", description: "Create a stream to send notifications by type from application code.", command: "notifications.new-stream" }}>
    {() => <AdminDataTable caption="Notification streams" selectable param="stream" rows={rows} rowKey={(row) => row.type} rowLabel={(row) => row.name}
      rowActions={(row) => row.source === "stream" ? [{ label: "Open", run: () => props.onSelect(row.type) }] : []}
      columns={[
        { header: "Stream", minWidth: "14rem", cell: (row) => <><p className="font-medium">{row.name}</p><AdminCode>{row.type}</AdminCode></> },
        { header: "Status", nowrap: true, cell: (row) => row.source === "code" ? <AdminStatus variant="info">code-defined</AdminStatus> : row.archivedAt ? <AdminStatus variant="neutral">archived</AdminStatus> : row.activeVersion ? <AdminStatus variant="success">{`active v${row.activeVersion}`}</AdminStatus> : <AdminStatus variant="warning">unpublished</AdminStatus> },
        { header: "Draft", nowrap: true, cell: (row) => row.draftVersion ? `v${row.draftVersion}` : "—" },
        { header: "Routes", nowrap: true, cell: (row) => row.routes.join(", ") || "—" },
        { header: "Policy", nowrap: true, priority: "low", cell: (row) => row.policy },
        { header: "Published", nowrap: true, priority: "low", cell: (row) => formatDate(row.publishedAt) },
      ]} />}
  </AdminQueryState>;
}
