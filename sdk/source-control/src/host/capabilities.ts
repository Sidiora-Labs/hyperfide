import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";

export const VIRTUAL_FILESYSTEM_PROFILE = Object.freeze({
  id: "linux-fuse7-source-v1",
  protocol: { major: 7, minimumMinor: 31, maximumMinor: 38 },
  platform: "linux",
  architectures: ["x64", "arm64"] as const,
  device: "/dev/fuse",
  mountType: "fuse.hyperfide",
  semantics: {
    read: true,
    write: true,
    atomicSave: true,
    rename: true,
    truncate: true,
    caseSensitive: true,
    symlink: true,
    executable: true,
    mmap: false,
    fileLocks: "kernel-local",
    hardLinks: false,
    specialFiles: false,
  },
});
export interface VirtualHostConfiguration {
  mount: { path: string; sha256: string };
  unmount: { path: string; sha256: string };
}
export interface VirtualHostCapabilities {
  profile: typeof VIRTUAL_FILESYSTEM_PROFILE;
  available: boolean;
  platform: string;
  architecture: string;
  kernel: string;
  reasons: string[];
  fallback: {
    modes: ["SPARSE", "MATERIALIZED"];
    requiresExplicitSelection: true;
  };
}
async function executable(pin: {
  path: string;
  sha256: string;
}): Promise<boolean> {
  if (!pin.path.startsWith("/") || !/^sha256:[0-9a-f]{64}$/.test(pin.sha256))
    return false;
  try {
    const file = await fs.open(
      pin.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== 0 ||
        stat.mode & 0o022 ||
        !(stat.mode & 0o111) ||
        stat.size > 32 * 1024 * 1024
      )
        return false;
      return (
        "sha256:" +
          createHash("sha256")
            .update(await file.readFile())
            .digest("hex") ===
        pin.sha256
      );
    } finally {
      await file.close();
    }
  } catch {
    return false;
  }
}
export async function discoverVirtualHost(
  configuration: VirtualHostConfiguration,
): Promise<VirtualHostCapabilities> {
  const reasons: string[] = [];
  if (process.platform !== "linux") reasons.push("LINUX_REQUIRED");
  if (
    !VIRTUAL_FILESYSTEM_PROFILE.architectures.includes(
      process.arch as "x64" | "arm64",
    ) ||
    os.endianness() !== "LE"
  )
    reasons.push("ARCHITECTURE_UNSUPPORTED");
  if (process.platform === "linux") {
    try {
      const status = await fs.readFile("/proc/self/status", "utf8");
      const effective = /^CapEff:\s*([0-9a-f]+)$/im.exec(status)?.[1];
      if (!effective || !(BigInt("0x" + effective) & (1n << 21n)))
        reasons.push("CAP_SYS_ADMIN_REQUIRED");
    } catch {
      reasons.push("KERNEL_CAPABILITIES_UNAVAILABLE");
    }
    try {
      const device = await fs.open(
        VIRTUAL_FILESYSTEM_PROFILE.device,
        constants.O_RDWR | constants.O_NOFOLLOW,
      );
      try {
        if (!(await device.stat()).isCharacterDevice())
          reasons.push("FUSE_DEVICE_INVALID");
      } finally {
        await device.close();
      }
    } catch {
      reasons.push("FUSE_DEVICE_UNAVAILABLE");
    }
  }
  if (!(await executable(configuration.mount)))
    reasons.push("MOUNT_EXECUTABLE_UNVERIFIED");
  if (!(await executable(configuration.unmount)))
    reasons.push("UNMOUNT_EXECUTABLE_UNVERIFIED");
  return {
    profile: VIRTUAL_FILESYSTEM_PROFILE,
    available: reasons.length === 0,
    platform: process.platform,
    architecture: process.arch,
    kernel: os.release(),
    reasons,
    fallback: {
      modes: ["SPARSE", "MATERIALIZED"],
      requiresExplicitSelection: true,
    },
  };
}
