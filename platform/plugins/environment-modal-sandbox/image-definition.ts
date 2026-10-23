import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { z } from "zod";
import { readStandardDockerfile, readStandardImage } from "./standard-image.js";

export const dockerfileSchema = z.string().min(1).max(65_536);
const key = "dockerfile-override";

export function imageDefinition(hyperfide: Pick<HyperfidePluginApi, "storage">) {
  return {
    async get() {
      const stored = await hyperfide.storage.kv.get<unknown>(key);
      return stored === undefined
        ? { dockerfile: await readStandardDockerfile(), customized: false }
        : { dockerfile: dockerfileSchema.parse(stored), customized: true };
    },
    async set(dockerfile: string) {
      const value = dockerfileSchema.parse(dockerfile);
      await readStandardImage(value);
      await hyperfide.storage.kv.set(key, value);
      return { dockerfile: value, customized: true };
    },
    async reset() {
      await hyperfide.storage.kv.delete(key);
      return { dockerfile: await readStandardDockerfile(), customized: false };
    },
  };
}

export type ImageDefinition = ReturnType<typeof imageDefinition>;
