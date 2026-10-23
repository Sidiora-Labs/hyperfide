import { describe, expect, it } from "vitest";
import {
  appSettingsSchema,
  defaultAppSettings,
  managedBranchPrefixSchema,
  MANAGED_BRANCH_PREFIX_MAX_LENGTH,
} from "../src/app-settings.js";

describe("managedBranchPrefixSchema", () => {
  it("accepts prefixes that start a valid branch name", () => {
    for (const prefix of ["hyperfide/", "", "sawyer/wt-", "team/hyperfide/", "wip_"]) {
      expect(managedBranchPrefixSchema.safeParse(prefix).success).toBe(true);
    }
  });

  it("rejects prefixes that cannot start a valid branch name", () => {
    for (const prefix of [
      " hyperfide/",
      "hyperfide //",
      "-hyperfide/",
      "/hyperfide/",
      "hyperfide//",
      "hyperfide../",
      "hyperfide:",
      "hyperfide~",
      "hyperfide\\",
      "hyperfide@{",
      ".hyperfide/",
      "a".repeat(MANAGED_BRANCH_PREFIX_MAX_LENGTH + 1),
    ]) {
      expect(managedBranchPrefixSchema.safeParse(prefix).success).toBe(false);
    }
  });

  it("defaults to the hyperfide namespace", () => {
    expect(defaultAppSettings.managedBranchPrefix).toBe("hyperfide/");
    expect(appSettingsSchema.parse(defaultAppSettings)).toEqual(
      defaultAppSettings,
    );
  });
});
