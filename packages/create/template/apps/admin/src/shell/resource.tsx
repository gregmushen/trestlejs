import { DownloadSimpleIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Banner, Button, Dialog } from "./kumo";
import { AdminForm, useAdminToast } from "./ui";
import { useViewSearch } from "./url-state";

/**
 * Shared resource-management patterns (docs/ADMIN_REQUIRED_CHANGES.md §2):
 * detail opens on demand in a side drawer instead of a permanent pane, create
 * flows open from the page's primary action, and newly generated secrets are
 * shown exactly once with an explicit copy or download step.
 */

/** Focus returns to the row (or control) that opened an overlay when it closes. */
function useReturnFocus(open: boolean) {
  const origin = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      const active = document.activeElement;
      origin.current = active instanceof HTMLElement && active !== document.body ? active : document.querySelector<HTMLElement>("tr[data-active]");
      return;
    }
    const target = origin.current ?? document.querySelector<HTMLElement>("tr[data-active]");
    if (target) window.setTimeout(() => { if (target.isConnected) target.focus({ preventScroll: true }); }, 0);
  }, [open]);
}

/**
 * Inspectable detail for the resource selected in the URL (`?selected=` by
 * default). It overlays the table from the right, so the table keeps its full
 * width, and closing it restores focus to the originating row.
 */
export function AdminDetailDrawer(props: { title: ReactNode; subtitle?: ReactNode; open: boolean; onClose: () => void; actions?: ReactNode; children: ReactNode; width?: "md" | "lg" }) {
  useReturnFocus(props.open);
  return <Dialog.Root open={props.open} onOpenChange={(next) => { if (!next) props.onClose(); }}>
    {props.open && <Dialog aria-describedby={undefined} className={`fixed! inset-y-0! right-0! left-auto! top-0! m-0! flex h-dvh max-h-dvh! w-full ${props.width === "lg" ? "max-w-3xl!" : "max-w-xl!"} translate-x-0! translate-y-0! flex-col rounded-none! p-0!`}>
      <div className="flex items-start justify-between gap-4 border-b border-kumo-hairline px-6 py-4">
        <div className="min-w-0">
          <Dialog.Title className="truncate text-lg font-semibold text-kumo-default">{props.title}</Dialog.Title>
          {props.subtitle && <div className="mt-0.5 text-sm text-kumo-subtle">{props.subtitle}</div>}
        </div>
        <Button variant="ghost" size="sm" shape="square" aria-label="Close details" onClick={props.onClose}><XIcon /></Button>
      </div>
      {props.actions && <div className="flex flex-wrap gap-2 border-b border-kumo-hairline px-6 py-3">{props.actions}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{props.children}</div>
    </Dialog>}
  </Dialog.Root>;
}

/** Binds a drawer to the view's `selected` URL parameter. */
export function useSelectedDetail<T>(rows: readonly T[] | undefined, key: (row: T) => string, param = "selected") {
  const [search, update] = useViewSearch();
  const id = search[param];
  const row = id ? rows?.find((candidate) => key(candidate) === id) : undefined;
  return { id, row, open: Boolean(id), close: () => update({ [param]: undefined }), select: (value: string) => update({ [param]: value }) };
}

/** A labelled definition list for drawer bodies. Human values first, identifiers as copyable metadata. */
export function AdminFacts(props: { items: ReadonlyArray<readonly [label: string, value: ReactNode]> }) {
  return <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
    {props.items.map(([label, value]) => <div key={label} className="contents"><dt className="text-kumo-subtle">{label}</dt><dd className="min-w-0 break-words text-kumo-default">{value ?? "—"}</dd></div>)}
  </dl>;
}

/**
 * A creation flow opened from the page's primary action. The form submits
 * with Enter or Mod+Enter; failures stay in the dialog.
 */
export function AdminCreateDialog(props: { open: boolean; onClose: () => void; title: string; description?: ReactNode; submitLabel: string; onSubmit: () => Promise<unknown>; children: ReactNode; disabled?: boolean; size?: "base" | "lg" }) {
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  useReturnFocus(props.open);
  useEffect(() => { if (props.open) setError(undefined); }, [props.open]);
  const submit = async () => {
    if (working || props.disabled) return;
    setWorking(true);
    setError(undefined);
    try { await props.onSubmit(); } catch (caught) { setError(caught instanceof Error ? caught.message : "The request failed"); } finally { setWorking(false); }
  };
  return <Dialog.Root open={props.open} onOpenChange={(next) => { if (!next) props.onClose(); }}>
    {props.open && <Dialog size={props.size ?? "base"} className="p-6">
      <Dialog.Title>{props.title}</Dialog.Title>
      {props.description && <Dialog.Description render={(renderProps) => <div {...renderProps} className="mt-1 text-sm text-kumo-subtle" />}>{props.description}</Dialog.Description>}
      <AdminForm label={props.title} className="mt-4 flex flex-col gap-3" onSubmit={() => void submit()}>
        {props.children}
        {error && <p role="alert" className="text-sm text-kumo-danger">{error}</p>}
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="secondary" onClick={props.onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={working} disabled={working || props.disabled}>{props.submitLabel}</Button>
        </div>
      </AdminForm>
    </Dialog>}
  </Dialog.Root>;
}

/**
 * The only place a newly generated secret appears. It is held in component
 * state until the operator confirms it is stored; it is never cached,
 * refetched, or recoverable afterwards.
 */
export function OneTimeSecretDialog(props: { secret: string | null; title: string; description: ReactNode; filename: string; onDone: () => void; extra?: ReactNode }) {
  const toast = useAdminToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (props.secret) setCopied(false); }, [props.secret]);
  const download = () => {
    if (!props.secret) return;
    const url = URL.createObjectURL(new Blob([`${props.secret}\n`], { type: "text/plain" }));
    const link = Object.assign(document.createElement("a"), { href: url, download: props.filename });
    link.click();
    URL.revokeObjectURL(url);
    setCopied(true);
  };
  return <Dialog.Root open={props.secret !== null} onOpenChange={() => undefined} disablePointerDismissal>
    {props.secret !== null && <Dialog size="lg" className="p-6">
      <Dialog.Title>{props.title}</Dialog.Title>
      <Banner className="mt-3" variant="alert" title="Shown once" description="This value cannot be displayed again. Store it now; later you can only rotate or revoke it." />
      <div className="mt-4 text-sm text-kumo-default">{props.description}</div>
      <code data-secret="" className="mt-3 block break-all rounded-lg bg-kumo-recessed px-3 py-3 font-mono text-sm text-kumo-default ring ring-kumo-hairline">{props.secret}</code>
      {props.extra}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-2">
        <span className="flex gap-2">
          <Button variant="primary" onClick={() => void navigator.clipboard.writeText(props.secret ?? "").then(() => { setCopied(true); toast.success("Copied to the clipboard"); }, (error) => toast.failure("Could not copy", error))}>Copy</Button>
          <Button variant="secondary" icon={<DownloadSimpleIcon />} onClick={download}>Download</Button>
        </span>
        <Button variant={copied ? "primary" : "secondary"} onClick={props.onDone}>{copied ? "I have stored it" : "Close without storing"}</Button>
      </div>
    </Dialog>}
  </Dialog.Root>;
}

/** Derives a stable key from a human name: lowercase words joined by underscores. */
export function keyFromName(name: string, separator: "_" | "-" = "_"): string {
  const edges = separator === "_" ? /^_+|_+$/gu : /^-+|-+$/gu;
  return name.trim().toLowerCase().normalize("NFKD").replace(/[^\p{Letter}\p{Number}]+/gu, separator).replace(edges, "").slice(0, 40);
}
