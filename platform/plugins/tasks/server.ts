import { defineRpcContract, type HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { z } from "zod";

import { createStore, registerTasksApi } from "./api";
import { registerAttachments } from "./attachments";
import { registerTasksCli } from "./cli";
import { registerDelegation } from "./delegate";
import { registerLifecycle } from "./lifecycle";
import { registerMentions } from "./mentions";

const TASKS_PLUGIN_NAME = "Tasks";
export const TASKS_PLUGIN_VERSION = "0.1.2";

const tasksRpcContract = defineRpcContract({
  ping: {
    input: z.null(),
    output: z.object({ ok: z.literal(true), version: z.string() }),
  },
});

function statusPayload() {
  return { name: TASKS_PLUGIN_NAME, version: TASKS_PLUGIN_VERSION };
}

export default async function plugin(hyperfide: HyperfidePluginApi) {
  hyperfide.log.info(`${TASKS_PLUGIN_NAME} ${TASKS_PLUGIN_VERSION} loaded`);

  const store = createStore(hyperfide);
  registerTasksApi(hyperfide, store);
  registerAttachments(hyperfide, store.tasks);
  registerTasksCli(hyperfide, store, statusPayload());
  registerDelegation(hyperfide, store);
  registerMentions(hyperfide, store);
  await registerLifecycle(hyperfide, store);

  hyperfide.rpc.register(tasksRpcContract, {
    ping(): { ok: true; version: string } {
      return { ok: true, version: TASKS_PLUGIN_VERSION };
    },
  });
}
