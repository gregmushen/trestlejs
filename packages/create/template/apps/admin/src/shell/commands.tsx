import { formatForDisplay, useHotkeys, useHotkeySequences } from "@tanstack/react-hotkeys";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { api } from "../api";
import { availableCommands, hotkeySteps, searchCommands, type AdminRegistry, type RegisteredCommand } from "../registry";
import { useAdmin } from "./context";
import { Banner, Button, CommandPalette, Dialog, Kbd, useSidebar } from "./kumo";
import { useViewSearch } from "./url-state";

/** A mounted view's implementation of one of its declared commands. */
export type CommandHandler = Readonly<{ enabled?: boolean; target?: string; run: () => void }>;
/** Destructive commands only open their confirmation dialog; they never mutate directly. */
export type ConfirmHandler = Readonly<{ enabled?: boolean; target?: string; confirm: () => void }>;
export type AdminCommandHandler = CommandHandler | ConfirmHandler;

type CommandContextValue = Readonly<{
  register: (id: string, get: () => AdminCommandHandler | undefined) => () => void;
  handler: (id: string) => AdminCommandHandler | undefined;
  version: number;
  refresh: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  shortcutsOpen: boolean;
  setShortcutsOpen: (open: boolean) => void;
}>;

const CommandContext = createContext<CommandContextValue | null>(null);

export function useCommandContext(): CommandContextValue {
  const value = useContext(CommandContext);
  if (!value) throw new Error("Admin commands require <CommandProvider>");
  return value;
}

/** Modal overlays own the keyboard. Toasts are non-modal dialogs (aria-modal="false") and never block shortcuts. */
export const overlaySelector = '[role="dialog"]:not([aria-modal="false"]), [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * True while a Kumo/Base UI overlay (dialog, menu, select, palette) is open.
 * Page shortcuts never fire underneath an overlay; the overlay owns the keys.
 */
export function overlayOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector(overlaySelector) !== null;
}

export function CommandProvider(props: { children: ReactNode }) {
  const handlers = useRef(new Map<string, () => AdminCommandHandler | undefined>());
  const [version, setVersion] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const refresh = useCallback(() => setVersion((current) => current + 1), []);
  const register = useCallback((id: string, get: () => AdminCommandHandler | undefined) => {
    handlers.current.set(id, get);
    refresh();
    return () => { if (handlers.current.get(id) === get) handlers.current.delete(id); refresh(); };
  }, [refresh]);
  const value = useMemo<CommandContextValue>(() => ({
    register, refresh, version, paletteOpen, setPaletteOpen, shortcutsOpen, setShortcutsOpen,
    handler: (id) => handlers.current.get(id)?.(),
  }), [paletteOpen, refresh, register, shortcutsOpen, version]);
  return <CommandContext.Provider value={value}>{props.children}</CommandContext.Provider>;
}

/**
 * Registers the mounted view's handlers for its declared commands. The same
 * handler runs from the visible control, the palette, and the hotkey, and it
 * unregisters when the view unmounts.
 */
export function useAdminCommands(handlers: Readonly<Record<string, AdminCommandHandler>>): void {
  const { register, refresh } = useCommandContext();
  const latest = useRef(handlers);
  latest.current = handlers;
  const ids = Object.keys(handlers).sort().join("|");
  useEffect(() => {
    const cleanups = ids.split("|").filter(Boolean).map((id) => register(id, () => latest.current[id]));
    return () => { for (const cleanup of cleanups) cleanup(); };
  }, [ids, register]);
  // Palette state and hotkey enablement follow the current target.
  const state = Object.entries(handlers).map(([id, handler]) => `${id}:${handler.enabled !== false}:${handler.target ?? ""}`).join("|");
  useEffect(() => { refresh(); }, [refresh, state]);
}

export const formatHotkey = (hotkey: string): string => hotkeySteps(hotkey).map((step) => formatForDisplay(step)).join(" then ");

type PaletteItem = Readonly<{ id: string; title: string; hint?: string; hotkey?: string; disabled?: boolean; run: () => void }>;
type PaletteGroup = Readonly<{ id: string; label: string; items: readonly PaletteItem[] }>;

/** The registered view for the current route, if any. */
export function useCurrentView(registry: AdminRegistry) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
  return registry.views.find((view) => view.path === normalized);
}

/**
 * Runs a command. Navigation goes to its view; a command on the current view
 * runs the mounted handler; a command on another view opens that view with the
 * command recorded in the URL so the operator can choose its target there.
 */
function useDispatch(currentViewId: string | undefined) {
  const navigate = useNavigate();
  const { handler } = useCommandContext();
  return useCallback((command: RegisteredCommand) => {
    if (command.kind === "navigate") { void navigate({ to: command.path as never }); return; }
    if (command.viewId !== currentViewId) { void navigate({ to: command.path as never, search: { command: command.id } as never }); return; }
    const mounted = handler(command.id);
    if (!mounted || mounted.enabled === false) return;
    if (command.destructive) { if ("confirm" in mounted) mounted.confirm(); return; }
    if ("run" in mounted) mounted.run();
  }, [currentViewId, handler, navigate]);
}

/**
 * The expert interface. Kumo renders the palette and shortcut reference;
 * TanStack Hotkeys owns every application binding. Only commands the operator
 * may run, on configured capabilities, are offered or bound.
 */
export function CommandLayer() {
  const { registry, navigationContext, supportSession, exitSupportSession, can } = useAdmin();
  const context = useCommandContext();
  const { paletteOpen, setPaletteOpen, shortcutsOpen, setShortcutsOpen, handler } = context;
  const navigate = useNavigate();
  const sidebar = useSidebar();
  const view = useCurrentView(registry);
  const dispatch = useDispatch(view?.id);
  const [query, setQuery] = useState("");
  const available = useMemo(() => availableCommands(registry, navigationContext), [navigationContext, registry]);

  const ready = useCallback((command: RegisteredCommand) => {
    const mounted = handler(command.id);
    return Boolean(mounted && mounted.enabled !== false && (command.destructive ? "confirm" in mounted : "run" in mounted));
    // `context.version` changes whenever a handler registers or its target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handler, context.version]);

  // Global search: organizations and users open selected, never as an unfiltered list.
  const term = query.trim();
  const searching = paletteOpen && term.length >= 2;
  const organizations = useQuery({ queryKey: ["admin", "palette", "organizations", term], queryFn: () => api.organizations(term), enabled: searching && can("platform.organizations.read"), staleTime: 10_000 });
  const users = useQuery({ queryKey: ["admin", "palette", "users", term], queryFn: () => api.users(term), enabled: searching && can("platform.users.read"), staleTime: 10_000 });

  const groups = useMemo<PaletteGroup[]>(() => {
    const close = () => { setPaletteOpen(false); setQuery(""); };
    const item = (command: RegisteredCommand, hint?: string, disabled = false): PaletteItem => ({
      id: command.id, title: command.label, ...(hint ? { hint } : {}), ...(command.hotkey ? { hotkey: command.hotkey } : {}), disabled,
      run: () => { close(); dispatch(command); },
    });
    const here = available.filter((command) => command.kind !== "navigate" && command.viewId === view?.id)
      .map((command) => ready(command) ? item(command) : item(command, command.requires ? `Select ${command.requires} first` : "Not available right now", true));
    const elsewhere = available.filter((command) => command.kind === "action" && command.viewId !== view?.id)
      .map((command) => item(command, `Opens ${registry.views.find((candidate) => candidate.id === command.viewId)?.navigation.label ?? "its view"}`));
    const navigation = available.filter((command) => command.kind === "navigate").map((command) => item(command));
    const contextItems: PaletteItem[] = supportSession ? [{ id: "support.exit", title: `Exit support context (${supportSession.organizationName})`, run: () => { close(); void exitSupportSession(); } }] : [];
    const results: PaletteItem[] = [
      ...(organizations.data?.organizations ?? []).slice(0, 5).map((organization) => ({ id: `org:${organization.id}`, title: organization.name, hint: `Organization · ${organization.slug}`, run: () => { close(); void navigate({ to: "/organizations" as never, search: { selected: organization.id } as never }); } })),
      ...(users.data?.users ?? []).slice(0, 5).map((user) => ({ id: `user:${user.id}`, title: user.name, hint: `User · ${user.email}`, run: () => { close(); void navigate({ to: "/users" as never, search: { selected: user.id } as never }); } })),
    ];
    const filter = (items: readonly PaletteItem[]) => searchCommands(items.map((entry) => ({ ...entry, label: entry.title, group: entry.hint ?? "", keywords: [] as string[] })), query);
    return [
      { id: "context", label: "Context", items: filter(contextItems) },
      { id: "results", label: "Organizations and users", items: results },
      { id: "here", label: view ? `On ${view.navigation.label}` : "This page", items: filter(here) },
      { id: "navigate", label: "Go to", items: filter(navigation) },
      { id: "elsewhere", label: "Actions", items: filter(elsewhere) },
    ].filter((group) => group.items.length > 0);
  }, [available, dispatch, exitSupportSession, navigate, organizations.data, query, ready, registry.views, setPaletteOpen, supportSession, users.data, view]);

  // Shell bindings. Kumo owns Escape and arrow keys inside its overlays.
  useHotkeys([
    { hotkey: "Mod+K", callback: () => { setShortcutsOpen(false); setPaletteOpen(!paletteOpen); }, options: { ignoreInputs: false } },
    { hotkey: "/", callback: () => { if (!overlayOpen()) { setQuery(""); setPaletteOpen(true); } } },
    { hotkey: "?", callback: () => { if (!overlayOpen()) setShortcutsOpen(true); } },
    { hotkey: "[", callback: () => { if (!overlayOpen()) sidebar.toggleSidebar(); } },
  ]);

  const idle = !paletteOpen && !shortcutsOpen;
  const bound = available.filter((command): command is RegisteredCommand & { hotkey: string } => Boolean(command.hotkey));
  const global = bound.filter((command) => command.scope === "global");
  const local = bound.filter((command) => command.scope !== "global" && command.viewId === view?.id);
  const guarded = (command: RegisteredCommand) => () => { if (!overlayOpen()) dispatch(command); };
  useHotkeySequences(global.filter((command) => hotkeySteps(command.hotkey).length > 1).map((command) => ({ sequence: hotkeySteps(command.hotkey) as never, callback: guarded(command), options: { enabled: idle } })));
  useHotkeys([
    ...global.filter((command) => hotkeySteps(command.hotkey).length === 1).map((command) => ({ hotkey: command.hotkey as never, callback: guarded(command), options: { enabled: idle } })),
    // View and selection bindings fire only while the mounted handler has a valid target.
    ...local.filter((command) => hotkeySteps(command.hotkey).length === 1).map((command) => ({ hotkey: command.hotkey as never, callback: guarded(command), options: { enabled: idle && ready(command) } })),
  ]);

  return <>
    <CommandPalette.Root<PaletteGroup, PaletteItem>
      open={paletteOpen}
      onOpenChange={(open) => { setPaletteOpen(open); if (!open) setQuery(""); }}
      items={groups}
      value={query}
      onValueChange={setQuery}
      itemToStringValue={(group) => group.label}
      filter={() => true}
      getSelectableItems={(all) => all.flatMap((group) => group.items.filter((entry) => !entry.disabled))}
      onSelect={(entry) => entry.run()}
    >
      <CommandPalette.Input aria-label="Search commands, organizations, and users" placeholder="Type a command, or search organizations and users…" />
      <CommandPalette.List>
        <CommandPalette.Results>
          {(group: PaletteGroup) => <CommandPalette.Group key={group.id} items={group.items as PaletteItem[]}>
            <CommandPalette.GroupLabel>{group.label}</CommandPalette.GroupLabel>
            <CommandPalette.Items>
              {(entry: PaletteItem) => <CommandPalette.Item key={entry.id} value={entry} disabled={entry.disabled ?? false} onClick={() => { if (!entry.disabled) entry.run(); }}>
                <span className="flex w-full items-center justify-between gap-3">
                  <span className="flex min-w-0 flex-col"><span className="truncate">{entry.title}</span>{entry.hint && <span className="truncate text-xs text-kumo-subtle">{entry.hint}</span>}</span>
                  {entry.hotkey && <Kbd>{formatHotkey(entry.hotkey)}</Kbd>}
                </span>
              </CommandPalette.Item>}
            </CommandPalette.Items>
          </CommandPalette.Group>}
        </CommandPalette.Results>
        <CommandPalette.Empty>{term.length >= 2 ? `Nothing you can run matches “${term}”.` : "No commands match."}</CommandPalette.Empty>
      </CommandPalette.List>
      <CommandPalette.Footer>
        <span className="flex items-center gap-2"><Kbd>↑↓</Kbd><span>Move</span></span>
        <span className="flex items-center gap-2"><Kbd>↵</Kbd><span>Run</span></span>
        <span className="flex items-center gap-2"><Kbd>{formatForDisplay("Escape")}</Kbd><span>Close</span></span>
      </CommandPalette.Footer>
    </CommandPalette.Root>
    <ShortcutReference open={shortcutsOpen} onOpenChange={setShortcutsOpen} global={global} local={local} viewLabel={view?.navigation.label} ready={ready} />
  </>;
}

const shellBindings: ReadonlyArray<readonly [string, string]> = [
  ["Mod+K", "Open the command palette"], ["/", "Search organizations and users"], ["?", "Show keyboard shortcuts"], ["[", "Collapse or expand the sidebar"], ["Escape", "Close the topmost overlay, or clear the selected row"],
];
const resourceBindings: ReadonlyArray<readonly [string, string]> = [
  ["f", "Focus the page filter"], ["j", "Next row"], ["k", "Previous row"], ["Enter", "Open the active row"], ["Shift+A", "Open the active row's actions"], ["Mod+Enter", "Submit a form or confirm"], ["Mod+Shift+Enter", "Confirm a destructive action"],
];

function ShortcutReference(props: { open: boolean; onOpenChange: (open: boolean) => void; global: readonly (RegisteredCommand & { hotkey: string })[]; local: readonly (RegisteredCommand & { hotkey: string })[]; viewLabel: string | undefined; ready: (command: RegisteredCommand) => boolean }) {
  const row = (keys: string, label: string, note?: string) => <li key={`${keys}-${label}`} className="flex items-center justify-between gap-4 py-1 text-sm"><span>{label}{note && <span className="text-kumo-subtle"> · {note}</span>}</span><Kbd>{formatHotkey(keys)}</Kbd></li>;
  const section = (title: string, children: ReactNode) => <section><h3 className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">{title}</h3><ul className="mt-1">{children}</ul></section>;
  return <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
    <Dialog size="xl" className="max-h-[85vh] overflow-y-auto p-6">
      <Dialog.Title>Keyboard shortcuts</Dialog.Title>
      <Dialog.Description>Only shortcuts for actions your platform role allows are listed.</Dialog.Description>
      <div className="mt-4 grid gap-6 sm:grid-cols-2">
        {section("Shell", shellBindings.map(([keys, label]) => row(keys, label)))}
        {section("Tables and forms", resourceBindings.map(([keys, label]) => row(keys, label)))}
        {props.local.length > 0 && section(props.viewLabel ?? "This page", props.local.map((command) => row(command.hotkey, command.label, props.ready(command) ? undefined : command.requires ? `select ${command.requires}` : "unavailable")))}
        {section("Go to", props.global.map((command) => row(command.hotkey, command.label)))}
      </div>
      <div className="mt-6 flex justify-end"><Dialog.Close render={<Button variant="secondary">Close</Button>} /></div>
    </Dialog>
  </Dialog.Root>;
}

/**
 * A command opened from another view arrives as ?command=<id>. The notice
 * says what to select; once a target is selected, the command's shortcut or
 * the row's action menu runs it through the same handler.
 */
export function CommandIntent() {
  const { registry } = useAdmin();
  const [search, update] = useViewSearch<{ command?: string }>();
  const view = useCurrentView(registry);
  const command = registry.commands.find((candidate) => candidate.id === search.command && candidate.viewId === view?.id);
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!command || focused.current === command.id) return;
    focused.current = command.id;
    const timer = window.setTimeout(() => document.querySelector<HTMLInputElement>("[data-admin-filter]")?.focus(), 150);
    return () => window.clearTimeout(timer);
  }, [command]);
  if (!command) return null;
  return <Banner className="mb-4" title={command.label}
    description={`${command.requires ? `Select ${command.requires}, then` : "Then"} ${command.hotkey ? `press ${formatHotkey(command.hotkey)} or ` : ""}use the row's actions.${command.destructive ? " You will be asked for a reason." : ""}`}
    action={<Button size="sm" variant="secondary" onClick={() => { focused.current = null; update({ command: undefined }, { replace: true }); }}>Dismiss</Button>} />;
}
