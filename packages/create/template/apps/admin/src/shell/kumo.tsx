/**
 * The admin's single import point for Kumo. Views import Kumo components from
 * here (or through the Trestle adapters in ./ui) so the pinned version and
 * the few Trestle-owned presentational helpers stay in one place.
 */
import type { ReactNode } from "react";

export * from "@cloudflare/kumo";

/** A keyboard key cap, styled with Kumo tokens. */
export function Kbd(props: { children: ReactNode }) {
  return <kbd className="inline-flex min-w-5 items-center justify-center rounded border border-kumo-hairline bg-kumo-base px-1.5 py-0.5 font-mono text-[11px] text-kumo-subtle">{props.children}</kbd>;
}
