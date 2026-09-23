/*
 * Installed from the Kumo resource-list block (@cloudflare/kumo 2.14.0,
 * dist/blocks-source/resource-list). Trestle owns this copy: the page header
 * and scroll container come from the admin shell, so it keeps only the
 * two-column resource/detail arrangement.
 */
import { cn } from "@cloudflare/kumo";
import type { ReactNode } from "react";

export interface ResourceListPageProps {
  /** Supporting detail for the selected resource; stacks below the list on narrow screens. */
  detail?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function ResourceListPage({ detail, children, className }: ResourceListPageProps) {
  return <div className={cn("flex flex-col gap-6 xl:flex-row xl:gap-8", className)}>
    <div className="min-w-0 grow">{children}</div>
    {detail && <div className="flex h-fit w-full min-w-0 shrink-0 flex-col gap-4 xl:sticky xl:top-28 xl:w-[440px]">{detail}</div>}
  </div>;
}
