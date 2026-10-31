import { useState, type ReactNode } from "react";
import type { ExperimentalPageTitle } from "@hyperfide/plugin-sdk/app";
import {
  getHyperfideDesktopInfo,
  shouldUseMacosDesktopChrome,
} from "@/lib/hyperfide-desktop";
import { AppBreadcrumbs } from "./AppBreadcrumbs";

export function PageTitleHeader({
  icon,
  title,
  value,
}: {
  icon: ReactNode;
  title: string;
  value: ExperimentalPageTitle | null;
}) {
  const [desktopInfo] = useState(getHyperfideDesktopInfo);
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const hasDetail = value?.title || value?.breadcrumbs?.length;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      {icon}
      <p className="truncate text-sm font-semibold">{title}</p>
      {hasDetail ? (
        <>
          <span aria-hidden="true" className="text-muted-foreground">
            /
          </span>
          {value?.breadcrumbs ? (
            <AppBreadcrumbs
              breadcrumbs={value.breadcrumbs}
              usesDesktopChrome={usesDesktopChrome}
            />
          ) : (
            <p className="truncate text-sm font-semibold">{value?.title}</p>
          )}
        </>
      ) : null}
    </div>
  );
}
