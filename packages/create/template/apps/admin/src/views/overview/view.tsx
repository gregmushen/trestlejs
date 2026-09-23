import { Link } from "@tanstack/react-router";
import { Suspense, lazy, useMemo } from "react";

import { api, type CapabilityStatus, type OverviewException } from "../../api";
import { useAdminCommands } from "../../shell/commands";
import { useAdmin, useAdminQuery } from "../../shell/context";
import { Grid, LayerCard } from "../../shell/kumo";
import { AdminCode, AdminLoading, AdminPageHeader, AdminQueryState, AdminSection, AdminStatus, formatDate, type StatusVariant } from "../../shell/ui";

const stateVariant: Record<CapabilityStatus["state"], StatusVariant> = { disabled: "neutral", declared: "warning", configured: "info", deployed: "success", verified: "success" };

export function CapabilityCard({ status }: { status: CapabilityStatus & { reportedAt?: string } }) {
  return <LayerCard data-capability={status.id} data-healthy={status.healthy ? "true" : "false"} tabIndex={-1} className="outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand">
    <LayerCard.Secondary className="flex items-center justify-between gap-2">
      <span className="font-medium text-kumo-default">{status.label}</span>
      <AdminStatus variant={status.healthy ? stateVariant[status.state] : "destructive"}>{status.healthy ? status.state : `${status.state} · unhealthy`}</AdminStatus>
    </LayerCard.Secondary>
    {(status.mode || status.message || status.reportedAt || status.repair) && <LayerCard.Primary className="text-sm">
      {status.mode && <p className="text-kumo-subtle">{status.mode}</p>}
      {status.message && <p className="mt-1 text-kumo-default">{status.message}</p>}
      {status.reportedAt && <p className="mt-1 text-xs text-kumo-subtle">Reported {formatDate(status.reportedAt)}</p>}
      {status.repair && <p className="mt-2 text-xs text-kumo-subtle">Repair: <AdminCode>{status.repair}</AdminCode></p>}
    </LayerCard.Primary>}
  </LayerCard>;
}

/** One actionable problem with a direct link to the affected resource. */
function ExceptionRow({ item }: { item: OverviewException }) {
  const [path, query] = item.href.split("?");
  return <li className="flex flex-wrap items-start justify-between gap-3 py-3">
    <div className="min-w-0 flex-1">
      <p className="flex items-center gap-2 text-sm font-medium text-kumo-default"><AdminStatus variant={item.severity === "critical" ? "destructive" : "warning"}>{item.severity}</AdminStatus>{item.title}</p>
      <p className="mt-0.5 text-sm text-kumo-subtle">{item.detail}</p>
    </div>
    <Link to={path as never} search={Object.fromEntries(new URLSearchParams(query ?? "")) as never} className="shrink-0 text-sm font-medium text-kumo-link underline-offset-2 hover:underline">Open</Link>
  </li>;
}

export default function OverviewView() {
  const { navigation } = useAdmin();
  const overview = useAdminQuery(["overview"], api.overview, { refetchInterval: 30_000 });
  const cards = useMemo(() => navigation.overviewCards.map((card) => ({ ...card, Component: lazy(card.component) })), [navigation.overviewCards]);
  useAdminCommands({
    "overview.refresh": { run: () => void overview.refetch() },
    "overview.focus-unhealthy": { enabled: Boolean(overview.data?.exceptions?.length), run: () => document.querySelector<HTMLElement>("[data-exceptions] a")?.focus() },
  });
  return <>
    <AdminPageHeader title="Overview" description="What needs attention, linked to the affected resource. Healthy systems are summarized below; configuration changes happen through trestle setup." />
    <AdminQueryState query={overview}>{(data) => {
      const exceptions = data.exceptions ?? [];
      const healthy = data.capabilities.filter((status) => status.state !== "disabled" && status.healthy && status.state !== "declared");
      return <>
        <AdminSection title={exceptions.length ? `Needs attention (${exceptions.length})` : "Nothing needs attention"} description={exceptions.length ? "Most severe first." : "No failing jobs, deliveries, reconciliations, or unhealthy capabilities."}>
          {exceptions.length ? <ul data-exceptions className="divide-y divide-kumo-hairline">{exceptions.map((item, index) => <ExceptionRow key={`${item.kind}:${index}`} item={item} />)}</ul>
            : <p className="text-sm text-kumo-subtle">All clear as of {formatDate(new Date().toISOString())}.</p>}
        </AdminSection>
        <AdminSection title="Healthy" description="Compact summary; open Health for detail.">
          <dl className="grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
            <div><dt className="text-kumo-subtle">Environment</dt><dd className="font-medium">{data.environment}</dd></div>
            <div><dt className="text-kumo-subtle">Organizations</dt><dd className="font-medium">{data.counts.organizations.toLocaleString()}</dd></div>
            <div><dt className="text-kumo-subtle">Users</dt><dd className="font-medium">{data.counts.users.toLocaleString()}</dd></div>
            <div><dt className="text-kumo-subtle">Email</dt><dd className="font-medium">{typeof data.providers.email === "string" ? data.providers.email : data.providers.email.mode}</dd></div>
            <div><dt className="text-kumo-subtle">Payments</dt><dd className="font-medium">{typeof data.providers.payments === "string" ? data.providers.payments : data.providers.payments.mode}</dd></div>
            <div><dt className="text-kumo-subtle">Migrations</dt><dd className="font-medium">{data.migrations.applied} applied</dd></div>
          </dl>
          {healthy.length > 0 && <p className="mt-3 flex flex-wrap gap-1 text-sm">{healthy.map((status) => <AdminStatus key={status.id} variant="success">{status.label}</AdminStatus>)}</p>}
        </AdminSection>
      </>;
    }}</AdminQueryState>
    {cards.length > 0 && <Grid variant="2up" gap="base">{cards.map(({ viewId, title, Component }) => <AdminSection key={viewId} title={title}><Suspense fallback={<AdminLoading />}><Component /></Suspense></AdminSection>)}</Grid>}
  </>;
}
