import { describe, expect, it } from "vitest";
import {
  deriveProjectNameFromPath,
  getProjectPathValidationMessage,
  INVALID_PROJECT_PATH_MESSAGE,
  isAbsoluteProjectPath,
  normalizeProjectPathInput,
  PROJECT_PATH_ROOT_MESSAGE,
  UNSUPPORTED_WINDOWS_NETWORK_PROJECT_PATH_MESSAGE,
} from "../src/project-path.js";

describe("project-path", () => {
  const windowsProjectPath = "C:\\Users\\michael\\hyperfide";
  const windowsRootPath = "C:\\";
  const uncProjectPath = "\\\\server\\share\\hyperfide";

  it("derives a project name from POSIX paths", () => {
    expect(deriveProjectNameFromPath("/srv/repos/hyperfide")).toBe("hyperfide");
    expect(deriveProjectNameFromPath("/srv/repos/hyperfide/")).toBe("hyperfide");
    expect(deriveProjectNameFromPath("/mnt/c/Users/michael/hyperfide/")).toBe("hyperfide");
  });

  it("derives a project name from Windows drive paths", () => {
    expect(deriveProjectNameFromPath(windowsProjectPath)).toBe("hyperfide");
    expect(deriveProjectNameFromPath("C:/Users/michael/hyperfide/")).toBe("hyperfide");
  });

  it("does not derive a project name from network paths or filesystem roots", () => {
    expect(deriveProjectNameFromPath(uncProjectPath)).toBe("");
    expect(deriveProjectNameFromPath("/")).toBe("");
    expect(deriveProjectNameFromPath(windowsRootPath)).toBe("");
    expect(deriveProjectNameFromPath("C:")).toBe("");
  });

  it("recognizes supported absolute paths", () => {
    expect(isAbsoluteProjectPath("/srv/repos/hyperfide")).toBe(true);
    expect(isAbsoluteProjectPath("/mnt/c/Users/michael/hyperfide")).toBe(true);
    expect(isAbsoluteProjectPath(windowsProjectPath)).toBe(true);
    expect(isAbsoluteProjectPath("c:/Users/michael/hyperfide")).toBe(true);
    expect(isAbsoluteProjectPath(uncProjectPath)).toBe(false);
    expect(isAbsoluteProjectPath("C:Users\\michael\\hyperfide")).toBe(false);
    expect(isAbsoluteProjectPath("relative/path")).toBe(false);
  });

  it("normalizes trailing separators without collapsing roots", () => {
    expect(normalizeProjectPathInput("/srv/repos/hyperfide/")).toBe("/srv/repos/hyperfide");
    expect(normalizeProjectPathInput("/mnt/c/Users/michael/hyperfide/")).toBe(
      "/mnt/c/Users/michael/hyperfide",
    );
    expect(normalizeProjectPathInput("/")).toBe("/");
    expect(normalizeProjectPathInput(windowsRootPath)).toBe(windowsRootPath);
  });

  it("stores one spelling for a Windows drive path", () => {
    for (const spelling of [
      windowsProjectPath,
      `${windowsProjectPath}\\`,
      "c:\\Users\\michael\\hyperfide",
      "C:/Users/michael/hyperfide/",
      "C:\\Users\\\\michael\\.\\hyperfide",
    ]) {
      expect(normalizeProjectPathInput(spelling)).toBe(windowsProjectPath);
    }
  });

  it("returns clear validation messages for unsupported path formats", () => {
    expect(getProjectPathValidationMessage("/srv/repos/hyperfide")).toBeNull();
    expect(
      getProjectPathValidationMessage("/mnt/c/Users/michael/hyperfide"),
    ).toBeNull();
    expect(getProjectPathValidationMessage(windowsProjectPath)).toBeNull();
    expect(getProjectPathValidationMessage("/")).toBe(
      PROJECT_PATH_ROOT_MESSAGE,
    );
    expect(getProjectPathValidationMessage(windowsRootPath)).toBe(
      PROJECT_PATH_ROOT_MESSAGE,
    );
    expect(getProjectPathValidationMessage("relative/path")).toBe(
      INVALID_PROJECT_PATH_MESSAGE,
    );
    expect(getProjectPathValidationMessage("C:Users\\michael\\hyperfide")).toBe(
      INVALID_PROJECT_PATH_MESSAGE,
    );
    expect(getProjectPathValidationMessage(uncProjectPath)).toBe(
      UNSUPPORTED_WINDOWS_NETWORK_PROJECT_PATH_MESSAGE,
    );
  });
});
