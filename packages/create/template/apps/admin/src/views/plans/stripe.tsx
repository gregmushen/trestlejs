import { useRef, useState } from "react";

import { api, type BillingMapping, type PlanVersionJson } from "../../api";
import { type useConfirmAction } from "../../shell/ConfirmAction";
import { useAdmin, useAdminQuery, useInvalidate } from "../../shell/context";
import { Button, Input, Select } from "../../shell/kumo";
import { AdminCode, AdminEmpty, AdminSection, AdminStatus, formatDate } from "../../shell/ui";

type Confirm = ReturnType<typeof useConfirmAction>;
type Draft = { mode: "connect" | "create"; externalId: string; offer: string; amount: string; currency: string; interval: "month" | "year" };

export function MappingStatus(props: { mapping: BillingMapping }) {
  const state = props.mapping.verification?.state ?? "unverified";
  return <AdminStatus variant={state === "verified" ? "success" : state === "failed" ? "destructive" : "neutral"}>{state}</AdminStatus>;
}

const priceLabel = (mapping: BillingMapping) => {
  const verification = mapping.verification;
  return verification?.unitAmount !== undefined && verification?.unitAmount !== null && verification?.currency ? `${(verification.unitAmount / 100).toFixed(2)} ${verification.currency.toUpperCase()}${verification.interval ? ` / ${verification.interval}` : ""}` : null;
};

function MappingFields(props: { kind: "product" | "price"; stripe: boolean; draft: { current: Draft } }) {
  const [state, setState] = useState(props.draft.current);
  const set = (next: Draft) => { props.draft.current = next; setState(next); };
  return <div className="flex flex-col gap-3">
    {props.stripe && <Select label="How" hideLabel={false} value={state.mode} onValueChange={(value) => set({ ...state, mode: String(value) as Draft["mode"] })}>
      <Select.Option value="connect">Connect an existing Stripe {props.kind}</Select.Option>
      <Select.Option value="create">Create it in Stripe</Select.Option>
    </Select>}
    {props.kind === "price" && <Input label="Offer (optional)" placeholder="monthly" description="Checkout uses the monthly (or unnamed) offer of the active version." value={state.offer} onChange={(event) => set({ ...state, offer: event.target.value.toLowerCase() })} />}
    {state.mode === "connect"
      ? <Input label={props.kind === "product" ? "Stripe product ID" : "Stripe price ID"} placeholder={props.kind === "product" ? "prod_…" : "price_…"} value={state.externalId} onChange={(event) => set({ ...state, externalId: event.target.value.trim() })} />
      : props.kind === "price" && <div className="grid gap-3 sm:grid-cols-3">
        <Input label="Amount" type="number" min={0} step="0.01" value={state.amount} onChange={(event) => set({ ...state, amount: event.target.value })} />
        <Input label="Currency" value={state.currency} onChange={(event) => set({ ...state, currency: event.target.value.toLowerCase() })} />
        <Select label="Interval" hideLabel={false} value={state.interval} onValueChange={(value) => set({ ...state, interval: String(value) as Draft["interval"] })}><Select.Option value="month">month</Select.Option><Select.Option value="year">year</Select.Option></Select>
      </div>}
  </div>;
}

/** Plan family -> Product and plan version + offer -> Price, per environment. */
export function StripeMappings(props: { version: PlanVersionJson; confirm: Confirm }) {
  const { can } = useAdmin();
  const invalidate = useInvalidate();
  const manage = can("platform.plans.manage");
  const mappings = useAdminQuery(["billing-mappings", props.version.plan], () => api.billingMappings(props.version.plan));
  const draft = useRef<Draft>({ mode: "connect", externalId: "", offer: "", amount: "", currency: "usd", interval: "month" });
  const refresh = () => { void invalidate("billing-mappings"); void invalidate("subscription"); };
  const data = mappings.data;
  const product = data?.mappings.find((mapping) => mapping.kind === "product") ?? null;
  const prices = data?.mappings.filter((mapping) => mapping.kind === "price" && mapping.planVersion === props.version.version) ?? [];
  const stripe = data?.stripe === "configured";
  const open = (kind: "product" | "price") => {
    draft.current = { mode: "connect", externalId: "", offer: kind === "price" && prices.length === 0 ? "" : "annual", amount: "", currency: "usd", interval: "month" };
    const target = kind === "product" ? `the ${props.version.plan} plan family` : `${props.version.plan}@${props.version.version}`;
    props.confirm.open({
      title: kind === "product" ? "Map the Stripe product" : "Map a Stripe price", confirmLabel: kind === "product" ? "Map product" : "Map price",
      scope: [`links ${target} explicitly; names are never matched`, stripe ? "verified against Stripe before it is saved" : "Stripe is not configured here: the mapping is saved unverified"],
      fields: <MappingFields kind={kind} stripe={stripe} draft={draft} />,
      onConfirm: (reason) => {
        const { mode, externalId, offer, amount, currency, interval } = draft.current;
        const base = { kind, plan: props.version.plan, ...(kind === "price" ? { planVersion: props.version.version, offer: offer || null } : {}) };
        if (mode === "create") return api.createBillingMapping({ ...base, ...(kind === "price" ? { unitAmount: Math.round(Number(amount) * 100), currency, interval } : {}) }, reason);
        if (!externalId) return Promise.reject(new Error(`Enter the Stripe ${kind} ID`));
        return api.connectBillingMapping({ ...base, externalId }, reason);
      },
      onDone: refresh,
    });
  };
  const disconnect = (mapping: BillingMapping) => props.confirm.open({ title: `Disconnect ${mapping.externalId}`, confirmLabel: "Disconnect", destructive: true, scope: ["Stripe is not changed", mapping.kind === "price" ? "checkout falls back to STRIPE_PRICES for this plan, if configured" : "prices for this plan can no longer be verified"], onConfirm: (reason) => api.disconnectBillingMapping(mapping.id, reason), onDone: refresh });
  const row = (label: string, mapping: BillingMapping) => <li key={mapping.id} className="flex flex-wrap items-center gap-2 text-sm">
    <span className="min-w-24 text-kumo-subtle">{label}</span><AdminCode>{mapping.externalId}</AdminCode><MappingStatus mapping={mapping} />
    {priceLabel(mapping) && <span>{priceLabel(mapping)}</span>}
    {mapping.verification?.reason && <span className="text-xs text-kumo-subtle">{mapping.verification.reason}</span>}
    <span className="text-xs text-kumo-subtle">{mapping.verifiedAt ? `verified ${formatDate(mapping.verifiedAt)}` : ""}</span>
    {manage && <span className="ml-auto flex gap-1">
      {stripe && <Button size="sm" variant="ghost" onClick={() => void api.verifyBillingMapping(mapping.id).then(refresh)}>Verify</Button>}
      <Button size="sm" variant="ghost" onClick={() => disconnect(mapping)}>Disconnect</Button>
    </span>}
  </li>;
  return <AdminSection title={`Stripe (${data?.environment ?? "…"})`} description="Explicit links used by checkout and webhook processing. Each environment keeps its own mappings.">
    {!data ? null : <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2">
        {product ? row("Product", product) : <li className="text-sm">No product mapped for <AdminCode>{props.version.plan}</AdminCode>.</li>}
        {prices.map((mapping) => row(mapping.offer ? `Price · ${mapping.offer}` : "Price", mapping))}
        {product && prices.length === 0 && <li><AdminEmpty title={`No price for ${props.version.plan}@${props.version.version}`} description="Checkout for this version is unavailable until a price is mapped." /></li>}
      </ul>
      {manage && <div className="flex gap-2">
        {!product && <Button variant="secondary" onClick={() => open("product")}>Map product</Button>}
        {product && props.version.state !== "retired" && <Button variant="secondary" onClick={() => open("price")}>Map price</Button>}
      </div>}
    </div>}
  </AdminSection>;
}
