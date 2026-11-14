import { Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { TooltipProvider } from "@hyperfide/shared-ui/tooltip";
import { Skeleton } from "@hyperfide/shared-ui/skeleton";
import { useUpdateGeneralSettings } from "@/hooks/mutations/settings-mutations";
import { useSystemConfig } from "@/hooks/queries/system-queries";

const OnboardingFlow = lazy(() =>
  import("./OnboardingFlow").then((module) => ({
    default: module.OnboardingFlow,
  })),
);

const ONBOARDING_SEEN_STORAGE_KEY = "hyperfide.onboarding.seen";

function OnboardingLoadingFallback() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading setup guide"
      className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6"
    >
      <Skeleton className="h-8 w-64 max-w-full" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-4 w-5/6 max-w-lg" />
      <div className="mt-4 flex justify-end">
        <Skeleton className="h-10 w-28 rounded-md" />
      </div>
    </div>
  );
}

function readOnboardingSeen(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_SEEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberOnboardingSeen(): void {
  try {
    window.localStorage.setItem(ONBOARDING_SEEN_STORAGE_KEY, "1");
  } catch {
    return;
  }
}

export function OnboardingGate({ children }: { children: ReactNode }) {
  const configQuery = useSystemConfig();
  const updateSettings = useUpdateGeneralSettings();
  const [firstRunClosed, setFirstRunClosed] = useState(false);
  const [seenBefore] = useState(readOnboardingSeen);

  const settings = configQuery.data?.generalSettings;
  const completedAt = settings?.onboardingCompletedAt;
  useEffect(() => {
    if (typeof completedAt === "string") rememberOnboardingSeen();
  }, [completedAt]);

  if (firstRunClosed && typeof completedAt === "string") {
    setFirstRunClosed(false);
  }

  if (settings === undefined) {
    return seenBefore || configQuery.isError || configQuery.failureCount > 0
      ? children
      : null;
  }

  const firstRun = settings.onboardingCompletedAt === null && !firstRunClosed;
  if (!firstRun) return children;

  return (
    <TooltipProvider delayDuration={300} disableHoverableContent>
      <div className="flex h-dvh w-full flex-col bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[var(--hyperfide-safe-area-bottom,env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)]">
        <Suspense fallback={<OnboardingLoadingFallback />}>
          <OnboardingFlow
            initialStep="agent"
            entry={seenBefore ? "replay" : "first_run"}
            onClose={() => {
              setFirstRunClosed(true);
              updateSettings.mutate({
                ...settings,
                onboardingCompletedAt: new Date().toISOString(),
              });
            }}
          />
        </Suspense>
      </div>
    </TooltipProvider>
  );
}
