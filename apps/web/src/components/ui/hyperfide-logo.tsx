import { cn } from "@hyperfide/shared-ui/lib/utils";
import hyperfideLogoUrl from "../../../../../assets/hyperfide-logo.svg";

export function HyperfideLogo({ className = "size-4" }: { className?: string }) {
  return (
    <img
      src={hyperfideLogoUrl}
      alt=""
      aria-hidden="true"
      className={cn(className, "object-contain dark:invert")}
    />
  );
}
