import { DurableMemoryBridge, taskScopeSchema, type TaskScope } from "../memory/durable-memory.js";

export class TaskMemory {
  constructor(private readonly memory: DurableMemoryBridge) {}

  async packet(basePacket: string, scope: TaskScope, requires: readonly string[]) {
    taskScopeSchema.parse(scope);
    const feature = scope.task.split("/")[0];
    const decisions = [];
    for (const task of new Set([scope.task, ...requires.map(id => id.includes("/") ? id : `${feature}/${id}`)])) {
      decisions.push(...await this.memory.recall({ ...scope, task }));
    }
    if (!decisions.length) return basePacket;
    return `${basePacket}\n\n## Recalled decisions\n\n${decisions.map(memory =>
      `- #${memory.id} [${memory.type}] (${memory.task}) ${memory.body.replace(/\r?\n/g, "\n  ")}`,
    ).join("\n")}\n`;
  }
}
