import type { Href } from "expo-router";

type HrefParams = Record<string, string | undefined>;

function untypedHref(pathname: string, params?: HrefParams): Href {
  const definedParams = params
    ? Object.fromEntries(
        Object.entries(params).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      )
    : undefined;
  const href: { pathname: string; params?: Record<string, string> } = {
    pathname,
    ...(definedParams && Object.keys(definedParams).length > 0
      ? { params: definedParams }
      : {}),
  };
  return href as Href;
}

export function firstParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function rawPathHref(path: string): Href {
  return path as Href;
}

export function webViewShellHref(
  params: { profileId?: string; path?: string } = {},
): Href {
  return untypedHref("/webview", {
    profileId: params.profileId,
    path: params.path,
  });
}

type SettingsSectionRoute = "device" | "appearance" | "notifications";

export function settingsSectionHref(section: SettingsSectionRoute): Href {
  return untypedHref(`/settings/${section}`);
}
