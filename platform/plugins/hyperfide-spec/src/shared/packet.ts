export const STANDING_RULES = "## Standing rules\n- Implement only this task. Stay inside `touches` plus files you must create; name anything else in your final message.\n- Verify for real: run the verify_cmd until it passes. Never weaken, stub or skip a test to make it pass. No false done.\n- When it passes, set this task's `status` to \"implemented\" in spec/{feature}/spec.kvx. Never run `cg spec done` and never set\n  \"done\": qualification reruns on main.\n- Make exactly one plain git commit on the current branch whose message ends with `[spec:{feature}/{task}]`.\n  No Co-Authored-By or any other trailer lines. Never push, never open a pull request, never touch CHANGELOG.md or CODEMAP.md, never read .env.\n- When you need a variable, secret, permission, decision or answer you cannot derive from the code or the spec, do not pick a default:\n  raise it with the codify MCP `ask_raise` tool (CG_TASK is set) and also write ASK.md at the repository root with: kind\n  (secret|variable|permission|decision|question), the question in one sentence, the options with the one you recommend, what is\n  blocked, and what you finished anyway. Finish everything that does not depend on the answer.\n- Base commit: {{{{BASE_COMMIT}}}}. Repository: the current directory; the binary is ./cg (run `make cg` after C changes).\n";

export interface PacketTask {
  title: string;
  requires?: string[];
  touches?: string[];
  verify_cmd?: string;
  [field: `do_${number}`]: string;
}

export function taskPacket(feature: string, id: string, task: PacketTask,
  baseCommit: string, preamble = ""): string {
  const lines = [`# Task ${feature}/${id}: ${task.title}`, "",
    `You are the worker for task ${id} of spec/${feature}/spec.kvx in this repository.`, "",
    "## Task", `- requires: ${task.requires?.join(", ") || "none"}`,
    `- touches: ${task.touches?.join(", ") || "none listed"}`,
    `- verify_cmd: \`${task.verify_cmd ?? ""}\``];
  for (const key of Object.keys(task).filter(k => /^do_\d+$/.test(k))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))) {
    lines.push(`- ${key}: ${task[key as `do_${number}`]}`);
  }
  const rules = STANDING_RULES.replaceAll("{feature}", feature)
    .replaceAll("{task}", id).replace("{{{{BASE_COMMIT}}}}", baseCommit);
  return lines.join("\n") + "\n\n" + rules + (preamble ? "\n" + preamble : "");
}
