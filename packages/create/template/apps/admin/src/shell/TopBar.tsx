import { DesktopIcon, KeyboardIcon, MagnifyingGlassIcon, MoonIcon, SignOutIcon, SunIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { sessionQueryKey } from "../api";
import { authClient } from "../auth-client";
import { breadcrumbsFor, type Environment } from "../registry";
import { formatHotkey, useCommandContext } from "./commands";
import { useAdmin } from "./context";
import { Badge, Breadcrumbs, Button, DropdownMenu, Kbd, Sidebar } from "./kumo";

export type ThemeMode = "system" | "light" | "dark";
const themeKey = "trestle.admin.theme";

const ThemeContext = createContext<[ThemeMode, (mode: ThemeMode) => void]>(["system", () => undefined]);

/**
 * Kumo themes by `data-mode` on the document element, so portalled overlays
 * follow it too. The choice persists locally and defaults to the system setting.
 */
export function ThemeProvider(props: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(() => { try { return (window.localStorage.getItem(themeKey) as ThemeMode | null) ?? "system"; } catch { return "system"; } });
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { document.documentElement.dataset.mode = mode === "system" ? (media.matches ? "dark" : "light") : mode; };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);
  const value = useMemo<[ThemeMode, (mode: ThemeMode) => void]>(() => [mode, (next) => { setMode(next); try { window.localStorage.setItem(themeKey, next); } catch { /* optional */ } }], [mode]);
  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>;
}

export const useThemeMode = () => useContext(ThemeContext);

const environmentVariant: Readonly<Record<Environment, "error" | "warning" | "neutral">> = { production: "error", staging: "warning", preview: "neutral", local: "neutral" };

export function EnvironmentBadge(props: { environment: Environment }) {
  return <Badge variant={environmentVariant[props.environment]} aria-label={`Environment: ${props.environment}`}>{props.environment.toUpperCase()}</Badge>;
}

function OperatorMenu() {
  const { session } = useAdmin();
  const { setShortcutsOpen } = useCommandContext();
  const queryClient = useQueryClient();
  const [mode, setMode] = useThemeMode();
  const signOut = async () => {
    await authClient().signOut();
    queryClient.clear();
    await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
  };
  return <DropdownMenu>
    <DropdownMenu.Trigger render={<Button variant="ghost" size="sm" aria-label={`Operator menu for ${session.operator.email}`}>
      <span aria-hidden="true" className="grid size-6 place-items-center rounded-full bg-kumo-contrast text-[10px] font-semibold text-kumo-inverse">{(session.operator.name || session.operator.email).slice(0, 2).toUpperCase()}</span>
      <span className="hidden max-w-40 truncate sm:inline">{session.operator.name}</span>
    </Button>} />
    <DropdownMenu.Content>
      <div className="px-2 py-1.5 text-sm"><p className="font-medium text-kumo-default">{session.operator.name}</p><p className="truncate text-kumo-subtle">{session.operator.email}</p><p className="mt-1 text-xs text-kumo-subtle">{session.roles.join(", ") || "no platform roles"}</p></div>
      <DropdownMenu.Separator />
      <DropdownMenu.RadioGroup value={mode} onValueChange={(value: ThemeMode) => setMode(value)}>
        <DropdownMenu.RadioItem value="system" icon={DesktopIcon}>System theme</DropdownMenu.RadioItem>
        <DropdownMenu.RadioItem value="light" icon={SunIcon}>Light</DropdownMenu.RadioItem>
        <DropdownMenu.RadioItem value="dark" icon={MoonIcon}>Dark</DropdownMenu.RadioItem>
      </DropdownMenu.RadioGroup>
      <DropdownMenu.Separator />
      <DropdownMenu.Item icon={KeyboardIcon} onClick={() => setShortcutsOpen(true)}>Keyboard shortcuts</DropdownMenu.Item>
      <DropdownMenu.Item icon={SignOutIcon} variant="danger" onClick={() => void signOut()}>Sign out</DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu>;
}

/** Compact top bar: sidebar trigger, breadcrumbs, command trigger, environment, operator. */
export function TopBar() {
  const { environment, registry } = useAdmin();
  const { setPaletteOpen } = useCommandContext();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const crumbs = breadcrumbsFor(registry, pathname);
  return <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-3 border-b border-kumo-line bg-kumo-base px-4 lg:px-8">
    <Sidebar.Trigger />
    <Breadcrumbs size="sm" className="min-w-0 flex-1">
      {crumbs.map((crumb, index) => index === crumbs.length - 1
        ? <Breadcrumbs.Current key={`${crumb.label}-${index}`}>{crumb.label}</Breadcrumbs.Current>
        : [crumb.to ? <Breadcrumbs.Link key={`${crumb.label}-${index}`} href={crumb.to}>{crumb.label}</Breadcrumbs.Link> : <span key={`${crumb.label}-${index}`} className="text-kumo-subtle">{crumb.label}</span>, <Breadcrumbs.Separator key={`sep-${index}`} />])}
    </Breadcrumbs>
    <Button variant="outline" size="sm" icon={MagnifyingGlassIcon} onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Meta+K Control+K">
      <span className="hidden md:inline">Search or run a command</span><Kbd>{formatHotkey("Mod+K")}</Kbd>
    </Button>
    <EnvironmentBadge environment={environment} />
    <OperatorMenu />
  </header>;
}
