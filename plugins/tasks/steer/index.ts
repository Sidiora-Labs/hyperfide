import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import type { TasksStore } from "../db";
import { errorMessage } from "../shared/errors";
import { isSideChatShapedThread } from "../shared/side-chat";

interface DeliverCommentInput {
  taskId: string;
  commentId: string;
  body: string;
  authorName: string;
}

function steerPrompt(
  taskKey: string,
  authorName: string,
  body: string,
): string {
  return (
    `New comment on task ${taskKey} from ${authorName}: ${body}\n\n` +
    "Treat this as updated context for your work on this task; " +
    `reply via hyperfide-platform tasks comment ${taskKey} when relevant.`
  );
}

export async function deliverCommentToLatestAgent(
  hyperfide: HyperfidePluginApi,
  store: TasksStore,
  input: DeliverCommentInput,
): Promise<number> {
  const task = store.getTask(input.taskId);
  if (!task) throw new Error(`Task not found: ${input.taskId}`);

  const latestReply = store.getLatestAgentComment(
    input.taskId,
    input.commentId,
  );
  if (!latestReply || latestReply.threadId === null) return 0;

  const threadId = latestReply.threadId;
  const prompt = steerPrompt(task.key, input.authorName, input.body);
  try {
    const thread = await hyperfide.sdk.threads.get({ threadId });
    if (isSideChatShapedThread(thread)) return 0;
    await hyperfide.sdk.threads.send({
      threadId,
      input: [{ type: "text", text: prompt, mentions: [] }],
      mode: "steer-if-active",
    });
    return 1;
  } catch (error) {
    hyperfide.log.warn(
      `failed to deliver comment ${input.commentId} to thread ${threadId}: ${errorMessage(error)}`,
    );
    return 0;
  }
}
