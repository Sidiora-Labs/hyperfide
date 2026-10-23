import { GraphMemoryBridge, taskScopeSchema, type TaskScope } from "../memory/graph-memory-projection.js";

// Projection of the 2.3 packet/detail seam. Its packet builder calls this with
// the existing packet and direct requires resolved to feature/task identifiers.
export class TaskMemoryProjection {
  constructor(private readonly memory: GraphMemoryBridge) {}

  async detail(scope: TaskScope) {
    return { recalledDecisions: await this.memory.recall(scope) };
  }

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
