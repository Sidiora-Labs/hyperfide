import { defineRpcContract, type HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { z } from "zod";
import {
  ANNOTATION_MENTION_PROVIDER_ID,
  annotationRecordSchema,
  annotationUpdateSchema,
  formatAnnotationContext,
} from "./annotations.js";

const STORAGE_PREFIX = "annotation:";

export const agentAnnotationsRpcContract = defineRpcContract({
  update: {
    input: annotationUpdateSchema,
    output: z.object({ id: z.string() }).strict(),
  },
  save: {
    input: annotationRecordSchema,
    output: z.object({ id: z.string() }).strict(),
  },
});

export default async function plugin(hyperfide: HyperfidePluginApi) {
  hyperfide.rpc.register(agentAnnotationsRpcContract, {
    async update({ id, comment }) {
      const record = annotationRecordSchema.parse(
        await hyperfide.storage.kv.get(`${STORAGE_PREFIX}${id}`),
      );
      await hyperfide.storage.kv.set(`${STORAGE_PREFIX}${id}`, { ...record, comment });
      return { id };
    },
    async save(annotation) {
      const id = annotation.id;
      await hyperfide.storage.kv.set(`${STORAGE_PREFIX}${id}`, annotation);
      return { id };
    },
  });
  hyperfide.ui.registerMentionProvider({
    id: ANNOTATION_MENTION_PROVIDER_ID,
    label: "Browser annotations",
    search: () => [],
    async resolve(id) {
      const parsed = annotationRecordSchema.safeParse(
        await hyperfide.storage.kv.get(`${STORAGE_PREFIX}${id}`),
      );
      if (!parsed.success) {
        throw new Error("This browser annotation is no longer available");
      }
      return { context: formatAnnotationContext(parsed.data) };
    },
  });
}
