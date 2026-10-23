import { Avatar, AvatarFallback, AvatarImage } from "@hyperfide/shared-ui/avatar";
import { cn } from "@hyperfide/shared-ui/lib/utils";
import { HyperfideLogo } from "@/components/ui/hyperfide-logo";

function authorInitials(name: string): string {
  const initials = name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase() ?? "")
    .join("");
  return initials === "" ? "?" : initials;
}

export function PluginAuthorAvatar({
  name,
  github,
  size,
  official = false,
}: {
  name: string;
  github: string | null;
  size: "detail" | "page";
  official?: boolean;
}) {
  const githubUsername = github ?? (official ? "hyperfide" : null);
  return (
    <Avatar
      role="img"
      aria-label={
        githubUsername === null ? `${name}'s avatar` : `${name}'s GitHub avatar`
      }
      className={cn(
        "border border-border bg-muted",
        size === "detail" ? "size-5" : "size-10",
      )}
    >
      {githubUsername === null ? null : (
        <AvatarImage
          src={`https://github.com/${githubUsername}.png?size=${size === "detail" ? 40 : 80}`}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      )}
      <AvatarFallback
        aria-hidden
        className={cn(
          "font-semibold text-subtle-foreground",
          size === "detail" ? "text-2xs" : "text-xs",
        )}
      >
        {official ? <HyperfideLogo className="size-4/5" /> : authorInitials(name)}
      </AvatarFallback>
    </Avatar>
  );
}
