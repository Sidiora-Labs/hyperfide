import {
  isDeveloperRoutePath,
  matchProfileForWebLink,
  parseIncomingLink,
  pathMatchesPrefix,
  type LinkProfileLike,
  type LinkResolution,
} from "../links/incoming-link";

export const SHELL_ROUTE_PATH = "/webview";

const NATIVE_ONLY_PREFIXES = [
  "/settings/servers",
  "/settings/device",
  "/settings/notifications",
] as const;

const NATIVE_ROUTE_ALIASES = {
  "/connect": "/settings/servers/add",
  "/settings/machines": "/settings/device",
} as const;

function nativeShellPath(path: string): string | null {
  const pathname = path.split("?", 1)[0] ?? "";
  const alias =
    NATIVE_ROUTE_ALIASES[pathname as keyof typeof NATIVE_ROUTE_ALIASES];
  if (alias !== undefined) return `${alias}${path.slice(pathname.length)}`;
  return pathMatchesPrefix(path, NATIVE_ONLY_PREFIXES) ? path : null;
}

interface ShellHrefParams {
  profileId: string | null;
  path: string;
}

function shellHref({ profileId, path }: ShellHrefParams): string {
  const params = new URLSearchParams();
  if (profileId !== null) params.set("profileId", profileId);
  if (path !== "/") params.set("path", path);
  const query = params.toString();
  return query.length > 0 ? `${SHELL_ROUTE_PATH}?${query}` : SHELL_ROUTE_PATH;
}

export interface ResolveShellLinkContext {
  profiles: readonly LinkProfileLike[];
  activeProfileId: string | null;
  developerRoutesEnabled: boolean;
}

export function resolveShellIncomingLink(
  url: string,
  context: ResolveShellLinkContext,
): LinkResolution {
  const link = parseIncomingLink(url);
  switch (link.kind) {
    case "foreign":
      return { kind: "passthrough" };
    case "scheme": {
      if (isDeveloperRoutePath(link.path)) {
        return {
          kind: "navigate",
          path: context.developerRoutesEnabled ? link.path : "/",
          profileId: null,
        };
      }
      const nativePath = nativeShellPath(link.path);
      if (nativePath !== null) {
        return { kind: "navigate", path: nativePath, profileId: null };
      }
      return {
        kind: "navigate",
        path: shellHref({ profileId: null, path: link.path }),
        profileId: null,
      };
    }
    case "web": {
      const match = matchProfileForWebLink(
        context.profiles,
        link.origin,
        link.pathname,
      );
      if (!match) {
        return {
          kind: "unknown-server",
          serverUrl: link.origin,
          path: shellHref({
            profileId: null,
            path: `${link.pathname}${link.search}`,
          }),
        };
      }
      const switching = match.profile.id !== context.activeProfileId;
      const targetPath = `${match.pathname}${link.search}`;
      const nativePath = nativeShellPath(targetPath);
      if (nativePath !== null) {
        return {
          kind: "navigate",
          path: nativePath,
          profileId: switching ? match.profile.id : null,
        };
      }
      return {
        kind: "navigate",
        path: shellHref({
          profileId: switching ? match.profile.id : null,
          path: targetPath,
        }),
        profileId: switching ? match.profile.id : null,
      };
    }
  }
}
