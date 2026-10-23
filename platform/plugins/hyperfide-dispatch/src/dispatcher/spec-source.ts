import type { SpecRpc } from "../../../hyperfide-spec/src/shared/model.js";
import { taskPacket } from "../../../hyperfide-spec/src/shared/packet.js";
import type { DispatcherOptions, SpecReadModel } from "./contracts.js";

/** Bind the spec plugin's read model and packet formatter to one dispatch feature. */
export function specSource(
  reader: SpecRpc,
  feature: string,
  ownership: Pick<SpecReadModel, "merged" | "claim" | "release">,
  baseCommit: () => Promise<string>,
  preamble = "",
): Pick<DispatcherOptions, "spec" | "packet"> {
  return {
    spec: {
      tasks: () => reader.tasks(feature),
      merged: (task, tip) => ownership.merged(task, tip),
      claim: (task, job) => ownership.claim(task, job),
      release: (task, job) => ownership.release(task, job),
    },
    async packet(task) {
      const value = await reader.task(feature, task);
      return {
        task,
        prompt: taskPacket(feature, task, { ...value }, await baseCommit(), preamble),
      };
    },
  };
}
