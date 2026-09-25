import { useEffect, useMemo, useState } from "react";

import { api, maskedKeyPrefix, type IssuedKey } from "../api";
import { useAdmin, useAdminQuery } from "./context";
import { Checkbox, Input, Select, Textarea } from "./kumo";
import { OrganizationPicker } from "./pickers";
import { AdminCreateDialog, OneTimeSecretDialog } from "./resource";
import { AdminCode, AdminEmpty } from "./ui";
import type { useConfirmAction } from "./ConfirmAction";

/** Scopes a key may carry: application permissions that accept API keys, limited to what the account holds. */
export function ScopePicker(props: { allowed: ReadonlySet<string> | null; value: string[]; onChange: (value: string[]) => void }) {
  const scopes = useAdminQuery(["api-key-scopes"], api.apiKeyScopes);
  const options = (scopes.data?.scopes ?? []).filter((scope) => !props.allowed || props.allowed.has(scope.code));
  if (scopes.data && options.length === 0) return <AdminEmpty title="No grantable scopes" description="The service account's roles grant no API-key permissions." />;
  return <fieldset className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-lg p-3 ring ring-kumo-hairline">
    <legend className="sr-only">Scopes</legend>
    {options.map((scope) => <label key={scope.code} className="flex items-start gap-2 text-sm">
      <Checkbox checked={props.value.includes(scope.code)} aria-label={scope.code} onCheckedChange={(on) => props.onChange(on ? [...new Set([...props.value, scope.code])].sort() : props.value.filter((code) => code !== scope.code))} />
      <span><span className="font-medium">{scope.name}</span> <AdminCode>{scope.code}</AdminCode>{scope.entitlement && <span className="block text-xs text-kumo-subtle">Requires the {scope.entitlement} entitlement</span>}</span>
    </label>)}
  </fieldset>;
}

/** The one place an API-key secret appears, with where it works and how it is used. */
export function IssuedKeyDialog(props: { issued: IssuedKey | null; onDone: () => void }) {
  const { environment } = useAdmin();
  return <OneTimeSecretDialog secret={props.issued?.token ?? null} title="API key created" filename={`${props.issued?.displayPrefix ?? "api-key"}.txt`} onDone={props.onDone}
    description={<>Key <AdminCode>{maskedKeyPrefix(props.issued?.displayPrefix ?? "")}</AdminCode> works only in <strong>{environment}</strong>. Send it as <AdminCode>Authorization: Bearer …</AdminCode>.
      {props.issued?.previous && <> The previous key keeps working until {new Date(props.issued.previous.expiresAt).toLocaleString()}.</>}</>} />;
}

type KeyDraft = { organizationId: string; serviceAccountId: string; name: string; scopes: string[]; expiresAt: string; cidrs: string };

/**
 * Create API key (docs/ADMIN_REQUIRED_CHANGES.md §6.2): organization, active
 * service account, name, scopes starting empty and bounded by the account,
 * optional expiry and network restrictions. One request identifier per
 * dialog makes a retried submit return the same key instead of a second one.
 */
export function CreateApiKeyDialog(props: { open: boolean; onClose: () => void; initial?: { organizationId: string; serviceAccountId?: string }; confirm: ReturnType<typeof useConfirmAction>; onIssued: (issued: IssuedKey) => void }) {
  const { environment } = useAdmin();
  const [draft, setDraft] = useState<KeyDraft>({ organizationId: "", serviceAccountId: "", name: "", scopes: [], expiresAt: "", cidrs: "" });
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (!props.open) return;
    setDraft({ organizationId: props.initial?.organizationId ?? "", serviceAccountId: props.initial?.serviceAccountId ?? "", name: "", scopes: [], expiresAt: "", cidrs: "" });
    setRequestId(crypto.randomUUID());
  }, [props.open, props.initial?.organizationId, props.initial?.serviceAccountId]);
  const accounts = useAdminQuery(["service-accounts", draft.organizationId], () => api.serviceAccounts(draft.organizationId), { enabled: props.open && Boolean(draft.organizationId) });
  const account = useAdminQuery(["service-account", draft.serviceAccountId], () => api.serviceAccount(draft.serviceAccountId), { enabled: props.open && Boolean(draft.serviceAccountId) });
  const allowed = useMemo(() => account.data ? new Set(account.data.effectivePermissions.map((permission) => permission.code)) : null, [account.data]);
  const cidrs = draft.cidrs.split(/[\s,]+/u).map((value) => value.trim()).filter(Boolean);
  const submit = async () => {
    const input = { serviceAccountId: draft.serviceAccountId, name: draft.name.trim(), scopes: draft.scopes, idempotencyKey: requestId, ...(draft.expiresAt ? { expiresAt: new Date(draft.expiresAt).toISOString() } : {}), ...(cidrs.length ? { allowedCidrs: cidrs } : {}) };
    const accountName = account.data?.account.name ?? draft.serviceAccountId;
    props.onClose();
    props.confirm.open({
      title: `Create API key ${input.name}`, confirmLabel: "Create key",
      scope: [`service account ${accountName}`, `environment ${environment}`, `scopes: ${input.scopes.join(", ")}`, input.expiresAt ? `expires ${new Date(input.expiresAt).toLocaleString()}` : "no expiry", cidrs.length ? `networks: ${cidrs.join(", ")}` : "any network"],
      onConfirm: async (reason) => await api.createApiKey(input, reason),
      onDone: (result) => { const issued = result as IssuedKey; if (issued.token) props.onIssued(issued); },
      successMessage: "API key created",
    });
  };
  const active = (accounts.data?.serviceAccounts ?? []).filter((candidate) => candidate.status === "active");
  return <AdminCreateDialog open={props.open} onClose={props.onClose} size="lg" title="Create API key" submitLabel="Review and create"
    description="The secret is shown once after creation. Scopes start empty and can never exceed the service account's roles, the tenant's entitlements, or the endpoint's policy."
    disabled={!draft.serviceAccountId || !draft.name.trim() || draft.scopes.length === 0} onSubmit={submit}>
    <OrganizationPicker value={draft.organizationId} onChange={(organizationId) => setDraft({ ...draft, organizationId, serviceAccountId: "", scopes: [] })} />
    <Select label="Service account" hideLabel={false} value={draft.serviceAccountId} disabled={!draft.organizationId} onValueChange={(value) => setDraft({ ...draft, serviceAccountId: String(value ?? ""), scopes: [] })}>
      {active.map((candidate) => <Select.Option key={candidate.id} value={candidate.id}>{candidate.name}</Select.Option>)}
    </Select>
    <Input label="Name" required placeholder="Production deploys" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
    <Input label="Environment" value={environment} disabled />
    {draft.serviceAccountId && <><p className="text-sm font-medium">Scopes ({draft.scopes.length})</p><ScopePicker allowed={allowed} value={draft.scopes} onChange={(scopes) => setDraft({ ...draft, scopes })} /></>}
    <Input label="Expires (optional)" type="datetime-local" value={draft.expiresAt} onChange={(event) => setDraft({ ...draft, expiresAt: event.target.value })} />
    <Textarea label="Allowed networks (optional CIDRs)" rows={2} placeholder="203.0.113.0/24" value={draft.cidrs} onChange={(event: { target: { value: string } }) => setDraft({ ...draft, cidrs: event.target.value })} />
  </AdminCreateDialog>;
}
