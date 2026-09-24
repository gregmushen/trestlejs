import { KeyboardIcon } from "@phosphor-icons/react";
import { useRouterState } from "@tanstack/react-router";

import type { NavigationItem } from "../registry";
import { formatHotkey, useCommandContext } from "./commands";
import { useAdmin } from "./context";
import { Badge, Kbd, Sidebar, Tooltip, useSidebar } from "./kumo";

const collapsedKey = "trestle.admin.sidebar.open";

/** The persisted sidebar preference; storage failures simply fall back to expanded. */
export function readSidebarOpen(): boolean {
  try { return window.localStorage.getItem(collapsedKey) !== "false"; } catch { return true; }
}
export function writeSidebarOpen(open: boolean): void {
  try { window.localStorage.setItem(collapsedKey, String(open)); } catch { /* preference is optional */ }
}

function NavItem(props: { item: NavigationItem; active: boolean }) {
  const { view, availability } = props.item;
  const { isMobile, setOpenMobile } = useSidebar();
  const Icon = view.navigation.icon;
  if (availability.kind === "unconfigured") {
    // Unconfigured capabilities stay visible, disabled, with the exact repair command.
    return <Sidebar.MenuItem>
      <Tooltip side="right" content={<span className="block max-w-72 text-sm">{availability.message} Run <code className="font-mono">{availability.repair}</code></span>}>
        <Sidebar.MenuButton icon={Icon} aria-disabled="true" className="cursor-not-allowed opacity-60">
          <span className="flex min-w-0 flex-1 items-center justify-between gap-2"><span className="truncate">{view.navigation.label}</span><Badge variant="warning">Setup</Badge></span>
        </Sidebar.MenuButton>
      </Tooltip>
    </Sidebar.MenuItem>;
  }
  return <Sidebar.MenuItem>
    <Sidebar.MenuButton icon={Icon} href={view.path} active={props.active} tooltip={view.navigation.label} aria-current={props.active ? "page" : undefined}
      onClick={() => { if (isMobile) setOpenMobile(false); }}>
      {view.navigation.label}
    </Sidebar.MenuButton>
  </Sidebar.MenuItem>;
}

/**
 * Registry-driven navigation. Core and consumer views render through this
 * same path; permission-hidden views never render, and hiding is never the
 * authorization boundary.
 */
export function AdminSidebar() {
  const { navigation } = useAdmin();
  const { setShortcutsOpen, setPaletteOpen } = useCommandContext();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const current = pathname.length > 1 ? pathname.replace(/\/+$/u, "") : pathname;
  return <Sidebar aria-label="Admin sections">
    {/* Same height and border as the top bar, so the logo row and breadcrumb row share one baseline and rule. */}
    <Sidebar.Header className="h-12 shrink-0 py-0! group-data-[state=collapsed]/sidebar:px-0">
      <a href="/" aria-label="__TRESTLE_PROJECT_NAME__ admin home" className="flex min-w-0 items-center gap-2 px-1 py-1 text-sm font-semibold text-kumo-default group-data-[state=collapsed]/sidebar:w-full group-data-[state=collapsed]/sidebar:justify-center">
        <span aria-hidden="true" className="grid size-7 place-items-center rounded-md bg-kumo-contrast text-xs font-bold text-kumo-inverse">T</span>
        <span className="truncate group-data-[state=collapsed]/sidebar:hidden">__TRESTLE_PROJECT_NAME__</span>
      </a>
    </Sidebar.Header>
    <Sidebar.Content>
      {navigation.groups.map((group) => <Sidebar.Group key={group.name}>
        <Sidebar.GroupLabel>{group.name}</Sidebar.GroupLabel>
        <Sidebar.Menu>{group.items.map((item) => <NavItem key={item.view.id} item={item} active={item.view.path === current} />)}</Sidebar.Menu>
      </Sidebar.Group>)}
    </Sidebar.Content>
    <Sidebar.Footer>
      <Sidebar.Menu>
        <Sidebar.MenuItem><Sidebar.MenuButton icon={KeyboardIcon} tooltip="Keyboard shortcuts" onClick={() => setShortcutsOpen(true)}>
          <span className="flex flex-1 items-center justify-between gap-2"><span>Shortcuts</span><span className="flex gap-1"><Kbd>{formatHotkey("Mod+K")}</Kbd><Kbd>?</Kbd></span></span>
        </Sidebar.MenuButton></Sidebar.MenuItem>
      </Sidebar.Menu>
      <button type="button" className="sr-only" onClick={() => setPaletteOpen(true)}>Open command palette</button>
    </Sidebar.Footer>
  </Sidebar>;
}
