import type { PromptInput } from "@hyperfide/domain";

interface PromptTextInputArgs {
  text: string;
}

export function promptTextInput(args: PromptTextInputArgs): PromptInput {
  return { type: "text", text: args.text, mentions: [] };
}
