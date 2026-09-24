/*
 * Installed from the Kumo page-header block (@cloudflare/kumo 2.14.0,
 * dist/blocks-source/page-header). Trestle owns this copy: it adds an actions
 * region and controlled tabs, and leaves breadcrumbs to the admin top bar.
 */
import { cn, Tabs, type TabsItem } from "@cloudflare/kumo";
import type { ReactNode } from "react";

export interface PageHeaderProps {
  breadcrumbs?: ReactNode;
  title?: string;
  description?: ReactNode;
  tabs?: TabsItem[];
  tab?: string;
  onTabChange?: (value: string) => void;
  /** Primary page actions, right-aligned beside the title. */
  actions?: ReactNode;
  className?: string;
  children?: ReactNode;
}

export function PageHeader({ breadcrumbs, title, description, tabs, tab, onTabChange, actions, className, children }: PageHeaderProps) {
  return <div className={cn("flex flex-col gap-2", className)}>
    {breadcrumbs && <div className="border-b border-kumo-line">{breadcrumbs}</div>}
    {(title || description || actions) && <div className="flex flex-wrap items-start justify-between gap-3 py-2">
      <div className="flex min-w-0 flex-col gap-1">
        {title && <h1 className="font-heading text-2xl font-semibold text-kumo-default">{title}</h1>}
        {description && <p className="max-w-prose text-sm text-kumo-subtle">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>}
    {tabs && <div className="flex w-full items-center justify-between border-b border-kumo-line pb-2">
      <Tabs tabs={tabs} variant="underline" {...(tab !== undefined ? { value: tab } : {})} onValueChange={(next) => onTabChange?.(String(next))} />
      <div className="flex items-center gap-2">{children}</div>
    </div>}
  </div>;
}
