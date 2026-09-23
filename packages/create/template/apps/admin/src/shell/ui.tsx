import { DotsThreeIcon, LockKeyIcon, WarningIcon } from "@phosphor-icons/react";
import { useHotkeys } from "@tanstack/react-hotkeys";
import type { UseQueryResult } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { PermissionDenied, errorMessage } from "../api";
import { PageHeader } from "../blocks/page-header";
import { overlayOpen, formatHotkey } from "./commands";
import { Badge, Banner, Button, DropdownMenu, Empty, InlineCopyText, Input, LayerCard, Loader, Meter, Pagination, SkeletonLine, Table, useKumoToastManager, type TabsItem } from "./kumo";
import { useViewSearch } from "./url-state";

/*
 * Trestle's semantic adapters over Kumo. Views describe meaning (a status, a
 * resource table, a destructive action); Kumo supplies presentation and widget
 * accessibility. Nothing here accepts raw color classes.
 */

export type StatusVariant = "success" | "warning" | "destructive" | "info" | "neutral";

const badgeVariants: Readonly<Record<StatusVariant, "success" | "warning" | "error" | "info" | "neutral">> = {
  success: "success", warning: "warning", destructive: "error", info: "info", neutral: "neutral",
};

const successWords = new Set(["active", "succeeded", "sent", "delivered", "captured", "healthy", "ok", "in_sync", "verified", "configured", "deployed", "granted", "enabled", "accepted"]);
const warningWords = new Set(["pending", "leased", "scheduled", "paused", "degraded", "grandfathered", "draft", "rotating", "declared", "expiring", "untested", "drift", "replaced"]);
const destructiveWords = new Set(["failed", "dead", "revoked", "suspended", "disabled", "bounced", "complained", "error", "expired", "failing", "retired", "denied", "cancelled", "exited", "missing"]);

/** Maps domain states to semantic variants. Color is never the only signal: the text is always shown. */
export function statusVariant(value: string | null | undefined): StatusVariant {
  const word = (value ?? "").toLowerCase();
  if (successWords.has(word)) return "success";
  if (warningWords.has(word)) return "warning";
  if (destructiveWords.has(word)) return "destructive";
  return "neutral";
}

export function AdminStatus(props: { variant?: StatusVariant; children: ReactNode; value?: string }) {
  const variant = props.variant ?? statusVariant(props.value ?? (typeof props.children === "string" ? props.children : ""));
  return <Badge variant={badgeVariants[variant]}>{props.children}</Badge>;
}

/** Page title, description, optional tabs, and primary actions; breadcrumbs live in the top bar. */
export function AdminPageHeader(props: { title: string; description?: ReactNode; actions?: ReactNode; tabs?: TabsItem[]; tab?: string; onTabChange?: (value: string) => void; children?: ReactNode }) {
  return <PageHeader className="mb-4" title={props.title} description={props.description} actions={props.actions}
    {...(props.tabs ? { tabs: props.tabs } : {})} {...(props.tab !== undefined ? { tab: props.tab } : {})} {...(props.onTabChange ? { onTabChange: props.onTabChange } : {})}>{props.children}</PageHeader>;
}

/** A titled surface for one resource or supporting detail. */
export function AdminSection(props: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <LayerCard className={`mb-6 ${props.className ?? ""}`}>
    <LayerCard.Secondary className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h2 className="text-base font-semibold text-kumo-default">{props.title}</h2>{props.description && <div className="mt-0.5 text-sm text-kumo-subtle">{props.description}</div>}</div>
      {props.actions && <div className="flex flex-wrap items-center gap-2">{props.actions}</div>}
    </LayerCard.Secondary>
    <LayerCard.Primary>{props.children}</LayerCard.Primary>
  </LayerCard>;
}

export function AdminLoading(props: { label?: string }) {
  return <div role="status" aria-live="polite" className="flex flex-col gap-2 py-4">
    <span className="flex items-center gap-2 text-sm text-kumo-subtle"><Loader size={14} />{props.label ?? "Loading…"}</span>
    <SkeletonLine /><SkeletonLine /><SkeletonLine />
  </div>;
}

export type EmptySpec = Readonly<{ title: string; description?: string; command?: string; action?: ReactNode }>;

export function AdminEmpty(props: EmptySpec) {
  return <Empty size="sm" title={props.title} {...(props.description ? { description: props.description } : {})} {...(props.command ? { commandLine: props.command } : {})} {...(props.action ? { contents: props.action } : {})} />;
}

/** Transport and permission failures. Denials offer no pointless retry; failures keep the correlation ID. */
export function AdminError(props: { error: unknown; retry?: () => void }) {
  if (props.error instanceof PermissionDenied) return <Banner variant="secondary" icon={<LockKeyIcon />} title="Not permitted" description={errorMessage(props.error)} />;
  const correlation = (props.error as { correlationId?: string } | undefined)?.correlationId;
  return <Banner variant="error" icon={<WarningIcon />} title="Unable to load" description={<>{errorMessage(props.error)}{correlation && <> · correlation <AdminCode>{correlation}</AdminCode></>}</>}
    {...(props.retry ? { action: <Button size="sm" variant="secondary" onClick={props.retry}>Try again</Button> } : {})} />;
}

/**
 * Loading, empty, error, and denied handling for one query. Background
 * refreshes keep the current data on screen instead of flashing a loader.
 */
export function AdminQueryState<T>(props: { query: UseQueryResult<T>; isEmpty?: (data: T) => boolean; empty?: EmptySpec | string; children: (data: T) => ReactNode }) {
  const { query } = props;
  if (query.isPending) return <AdminLoading />;
  if (query.isError && query.data === undefined) return <AdminError error={query.error} retry={() => void query.refetch()} />;
  const data = query.data as T;
  if (props.isEmpty?.(data)) {
    const empty = typeof props.empty === "string" ? { title: props.empty } : props.empty ?? { title: "Nothing to show yet" };
    return <AdminEmpty {...empty} />;
  }
  return <>{query.isError && <div className="mb-3"><AdminError error={query.error} retry={() => void query.refetch()} /></div>}{props.children(data)}</>;
}

/**
 * The page's primary filter. `f` focuses it from anywhere on the page; the
 * value lives in the URL so back, forward, and shared links restore it.
 */
export function AdminFilter(props: { label: string; placeholder: string; param?: string; primary?: boolean; className?: string }) {
  const param = props.param ?? "q";
  const [search, update] = useViewSearch();
  const [value, setValue] = useState(search[param] ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setValue(search[param] ?? ""); }, [param, search]);
  useEffect(() => {
    const timer = window.setTimeout(() => { if ((search[param] ?? "") !== value.trim()) update({ [param]: value.trim() || undefined }, { replace: true }); }, 250);
    return () => window.clearTimeout(timer);
    // Only the typed value drives the debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useHotkeys([{ hotkey: "F", callback: (event) => { if (overlayOpen()) return; event.preventDefault(); ref.current?.focus(); ref.current?.select(); }, options: { enabled: props.primary !== false } }]);
  return <form role="search" className={props.className ?? "mb-4 max-w-md"} onSubmit={(event) => event.preventDefault()}>
    <Input ref={ref} data-admin-filter="" aria-label={props.label} label={props.label} type="search" placeholder={props.placeholder} value={value} onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Escape" && value) { event.stopPropagation(); setValue(""); } }} />
  </form>;
}

export type AdminColumn<T> = Readonly<{
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
  /** Minimum readable width, e.g. "12rem"; the table scrolls horizontally before columns get narrower. */
  minWidth?: string;
  /** Timestamps, identifiers, and codes never wrap one word per line. */
  nowrap?: boolean;
  /** Low-priority columns are hidden below the large breakpoint instead of squeezing the rest. */
  priority?: "high" | "low";
}>;
/** A row action: the same handler the command registry binds, shown with its shortcut. */
export type AdminRowAction = Readonly<{ label: string; run: () => void; hotkey?: string; destructive?: boolean; disabled?: boolean }>;

const pageSize = 25;

/**
 * A keyboard-operable resource table. j/k move the active row (focus follows,
 * so assistive technology announces it), Enter selects it, Shift+A opens its
 * action menu, and Escape clears the selection. Selection and page live in
 * the URL through the view's `selected` and `page` parameters.
 */
export function AdminDataTable<T>(props: {
  caption: string;
  rows: readonly T[];
  columns: readonly AdminColumn<T>[];
  rowKey: (row: T) => string;
  /** Selects rows into the URL (`?selected=`). Omit for read-only tables. */
  selectable?: boolean;
  rowLabel?: (row: T) => string;
  rowActions?: (row: T) => readonly AdminRowAction[];
  /** Only the primary table on a page receives j/k/Enter/Shift+A/Escape. */
  primary?: boolean;
  param?: string;
  /** Server-side pagination: the rows are one page and the total is known to the server. */
  server?: Readonly<{ totalCount: number; pageSize: number }>;
}) {
  const param = props.param ?? "selected";
  const [search, update] = useViewSearch();
  const selected = search[param];
  const page = Math.max(1, Number(search.page ?? 1) || 1);
  const size = props.server?.pageSize ?? pageSize;
  const total = props.server?.totalCount ?? props.rows.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const visible = useMemo(() => props.server ? props.rows : props.rows.slice((Math.min(page, pages) - 1) * size, Math.min(page, pages) * size), [page, pages, props.rows, props.server, size]);
  const columnClass = (column: AdminColumn<T>) => [column.className, column.nowrap ? "whitespace-nowrap" : "", column.priority === "low" ? "hidden lg:table-cell" : ""].filter(Boolean).join(" ");
  const [active, setActive] = useState<string | undefined>(selected);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());
  const primary = props.primary !== false;
  useEffect(() => { if (selected) setActive(selected); }, [selected]);

  const keys = visible.map(props.rowKey);
  const focusRow = (key: string | undefined) => {
    if (!key) return;
    setActive(key);
    const element = rowRefs.current.get(key);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "nearest" });
  };
  const move = (delta: number) => {
    if (!keys.length) return;
    const index = active ? keys.indexOf(active) : -1;
    focusRow(keys[index < 0 ? (delta > 0 ? 0 : keys.length - 1) : Math.min(keys.length - 1, Math.max(0, index + delta))]);
  };
  const select = (key: string | undefined) => { if (props.selectable && key) update({ [param]: key }); };
  const interactiveFocus = () => {
    const element = document.activeElement;
    return element instanceof HTMLButtonElement || element instanceof HTMLAnchorElement || element instanceof HTMLSelectElement;
  };
  const guard = (work: () => void) => (event: KeyboardEvent) => { if (overlayOpen()) return; event.preventDefault(); work(); };
  useHotkeys([
    { hotkey: "J", callback: guard(() => move(1)), options: { enabled: primary } },
    { hotkey: "K", callback: guard(() => move(-1)), options: { enabled: primary } },
    { hotkey: "Enter", callback: (event) => { if (overlayOpen() || interactiveFocus() || !active) return; event.preventDefault(); select(active); }, options: { enabled: primary && Boolean(props.selectable) } },
    { hotkey: "Shift+A", callback: guard(() => { if (active && props.rowActions) setMenuFor(active); }), options: { enabled: primary && Boolean(props.rowActions) } },
    { hotkey: "Escape", callback: (event) => { if (overlayOpen() || !selected) return; event.preventDefault(); update({ [param]: undefined }); }, options: { enabled: primary && Boolean(props.selectable) } },
  ]);

  return <div className="flex flex-col gap-3">
    <div role="region" aria-label={props.caption} className="overflow-x-auto rounded-lg ring ring-kumo-hairline">
      <Table layout="auto">
        <caption className="sr-only">{props.caption}{props.selectable ? ". Use j and k to move, Enter to open." : ""}</caption>
        <Table.Header>
          <Table.Row>
            {props.columns.map((column) => <Table.Head key={column.header} className={`${columnClass(column)} whitespace-nowrap`} style={column.minWidth ? { minWidth: column.minWidth } : undefined}>{column.header}</Table.Head>)}
            {props.rowActions && <Table.Head className="w-10"><span className="sr-only">Actions</span></Table.Head>}
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {visible.map((row) => {
            const key = props.rowKey(row);
            const isSelected = selected === key;
            const isActive = active === key;
            const actions = props.rowActions?.(row) ?? [];
            return <Table.Row key={key} ref={(element: HTMLTableRowElement | null) => { if (element) rowRefs.current.set(key, element); else rowRefs.current.delete(key); }}
              variant={isSelected ? "selected" : "default"} aria-selected={props.selectable ? isSelected : undefined}
              tabIndex={isActive || (!active && key === keys[0]) ? 0 : -1} data-active={isActive ? "" : undefined}
              className={`${props.selectable ? "cursor-pointer" : ""} outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand data-[active]:bg-kumo-tint`}
              onFocus={() => setActive(key)} onClick={() => { setActive(key); select(key); }}>
              {props.columns.map((column) => <Table.Cell key={column.header} className={columnClass(column)} style={column.minWidth ? { minWidth: column.minWidth } : undefined}>{column.cell(row)}</Table.Cell>)}
              {props.rowActions && <Table.Cell className="w-10" onClick={(event) => event.stopPropagation()}>
                {actions.length > 0 && <DropdownMenu open={menuFor === key} onOpenChange={(open) => setMenuFor(open ? key : null)}>
                  <DropdownMenu.Trigger render={<Button variant="ghost" size="sm" shape="square" aria-label={`Actions for ${props.rowLabel?.(row) ?? key}`}><DotsThreeIcon /></Button>} />
                  <DropdownMenu.Content>
                    {actions.map((action) => <DropdownMenu.Item key={action.label} variant={action.destructive ? "danger" : "default"} disabled={action.disabled ?? false} onClick={() => { setMenuFor(null); action.run(); }}>
                      <span className="flex w-full items-center justify-between gap-4"><span>{action.label}</span>{action.hotkey && <span className="font-mono text-xs text-kumo-subtle">{formatHotkey(action.hotkey)}</span>}</span>
                    </DropdownMenu.Item>)}
                  </DropdownMenu.Content>
                </DropdownMenu>}
              </Table.Cell>}
            </Table.Row>;
          })}
        </Table.Body>
      </Table>
    </div>
    {pages > 1 && <Pagination page={Math.min(page, pages)} setPage={(next) => update({ page: next > 1 ? String(next) : undefined })} perPage={size} totalCount={total} controls="simple" />}
  </div>;
}

/**
 * A form that submits with Mod+Enter while focus is inside it, as well as
 * with its submit button. Destructive changes use the confirmation dialog.
 */
export function AdminForm(props: { onSubmit: () => void; children: ReactNode; className?: string; label?: string }) {
  const ref = useRef<HTMLFormElement>(null);
  useHotkeys([{ hotkey: "Mod+Enter", callback: (event) => { if (overlayOpen() || !ref.current?.contains(document.activeElement)) return; event.preventDefault(); props.onSubmit(); }, options: { ignoreInputs: false } }]);
  return <form ref={ref} aria-label={props.label} className={props.className} onSubmit={(event) => { event.preventDefault(); props.onSubmit(); }}>{props.children}</form>;
}

/** A compact metric on the overview surfaces. */
export function AdminStat(props: { label: string; value: ReactNode; hint?: ReactNode; variant?: StatusVariant }) {
  return <LayerCard>
    <LayerCard.Secondary className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">{props.label}</LayerCard.Secondary>
    <LayerCard.Primary>
      <p className={`text-2xl font-semibold ${props.variant === "destructive" ? "text-kumo-danger" : props.variant === "warning" ? "text-kumo-warning" : "text-kumo-default"}`}>{props.value}</p>
      {props.hint && <div className="mt-1 text-xs text-kumo-subtle">{props.hint}</div>}
    </LayerCard.Primary>
  </LayerCard>;
}

/** Quota and usage with an accessible label and value text. */
export function AdminUsageMeter(props: { label: string; used: number; limit: number | null; included?: number }) {
  const ceiling = props.limit ?? props.included ?? 0;
  return <Meter label={props.label} value={ceiling > 0 ? Math.min(props.used, ceiling) : 0} max={ceiling > 0 ? ceiling : 1} showValue
    customValue={`${props.used.toLocaleString()} of ${props.limit === null ? `${(props.included ?? 0).toLocaleString()} included` : ceiling.toLocaleString()}`} />;
}

/** Identifiers operators copy: correlation IDs, session IDs, request IDs. Never secrets. */
export function AdminCopy(props: { value: string; label?: string }) {
  return <InlineCopyText labels={{ copy: props.label ? `Copy ${props.label}` : "Copy" } as never}>{props.value}</InlineCopyText>;
}

/** Inline identifiers and permission codes. */
export function AdminCode(props: { children: ReactNode }) {
  return <code className="rounded bg-kumo-recessed px-1.5 py-0.5 font-mono text-xs text-kumo-default">{props.children}</code>;
}

/** Announces a mutation outcome; the durable record of a partial failure stays on the page. */
export function useAdminToast() {
  const toasts = useKumoToastManager();
  return {
    success: (title: string, description?: string) => toasts.add({ title, ...(description ? { description } : {}), variant: "success" }),
    failure: (title: string, error: unknown) => toasts.add({ title, description: errorMessage(error), variant: "error" }),
  };
}

export const formatDate = (value: string | null | undefined): string => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};
export const formatNumber = (value: number | null | undefined): string => value === null ? "Unlimited" : value === undefined ? "—" : value.toLocaleString();
export const formatBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};
export const formatValue = (value: unknown): string =>
  value === null ? "unlimited" : value === undefined ? "—" : typeof value === "boolean" ? (value ? "yes" : "no") : typeof value === "number" ? value.toLocaleString() : String(value);

export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setDebounced(value), delay); return () => clearTimeout(timer); }, [delay, setDebounced, value]);
  return debounced;
}
