import { z } from "zod";

const isoUtcDateTimeSchema = z.iso.datetime();

const hyperfideDesktopVersionFeedFileSchema = z.object({
  url: z.string().min(1),
  sha512: z.string().min(1),
  size: z.number().int().nonnegative(),
});

export const hyperfideDesktopVersionFeedPlatformSchema = z.enum([
  "macos",
  "linux",
  "windows",
]);
export type HyperfideDesktopVersionFeedPlatform = z.infer<
  typeof hyperfideDesktopVersionFeedPlatformSchema
>;

export const hyperfideDesktopVersionFeedSchema = z.object({
  schemaVersion: z.literal(1),
  channel: z.enum(["latest", "nightly"]),
  platform: hyperfideDesktopVersionFeedPlatformSchema,
  version: z.string().min(1),
  releaseDate: isoUtcDateTimeSchema,
  releaseName: z.string().min(1),
  releaseNotes: z.string().nullable(),
  minimumSystemVersion: z.string().min(1).nullable(),
  files: z.array(hyperfideDesktopVersionFeedFileSchema).min(1),
  path: z.string().min(1),
  sha512: z.string().min(1),
  stagingPercentage: z.number().min(0).max(100).nullable(),
});
export type HyperfideDesktopVersionFeed = z.infer<typeof hyperfideDesktopVersionFeedSchema>;

const HYPERFIDE_DESKTOP_VERSION_FEED_FILE_NAMES = {
  linux: "desktop-version-linux.json",
  macos: "desktop-version.json",
  windows: "desktop-version-windows.json",
} as const satisfies Record<HyperfideDesktopVersionFeedPlatform, string>;

export function createHyperfideDesktopVersionFeedFileName(
  platform: HyperfideDesktopVersionFeedPlatform,
): string {
  return HYPERFIDE_DESKTOP_VERSION_FEED_FILE_NAMES[platform];
}
