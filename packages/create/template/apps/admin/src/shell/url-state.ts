import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

/**
 * Keys a view keeps in the URL: search text, filters, the selected resource,
 * the active tab, and a pending command. Values are plain strings so a copied
 * URL reproduces the same administrative view. Never put secrets here.
 */
export type ViewSearch = Readonly<Record<string, string | undefined>>;

const allowed = /^[A-Za-z0-9._:@ -]{0,200}$/u;

/** Coerces router search into strings and drops anything that is not a short, safe token. */
export function sanitizeSearch(search: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!search || typeof search !== "object") return result;
  for (const [key, value] of Object.entries(search as Record<string, unknown>)) {
    const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
    if (text !== undefined && text !== "" && allowed.test(text)) result[key] = text;
  }
  return result;
}

/**
 * Reads and updates the current view's search state. Updates push history
 * entries so back and forward restore filters and selection; pass
 * `{ replace: true }` for keystroke-level changes such as typing in a filter.
 */
export function useViewSearch<T extends ViewSearch = ViewSearch>(): [T, (patch: Partial<Record<keyof T & string, string | undefined>>, options?: { replace?: boolean }) => void] {
  const raw = useRouterState({ select: (state) => state.location.search });
  const navigate = useNavigate();
  const search = useMemo(() => sanitizeSearch(raw) as T, [raw]);
  const update = useCallback((patch: Partial<Record<keyof T & string, string | undefined>>, options: { replace?: boolean } = {}) => {
    void navigate({
      to: ".",
      replace: options.replace ?? false,
      search: ((previous: unknown) => {
        const next: Record<string, string> = { ...sanitizeSearch(previous) };
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined || value === "") delete next[key];
          else next[key] = String(value);
        }
        return next;
      }) as never,
    });
  }, [navigate]);
  return [search, update];
}
