import type {
  TaskRunner,
  TaskPacket,
  RunnerResult,
} from "../dispatcher/contracts";
export class EchoRunner implements TaskRunner {
  calls: { packet: TaskPacket; machine: string; key: string }[] = [];
  results: (RunnerResult | Error)[] = [];
  async run(
    packet: TaskPacket,
    machine: { id: string },
    key: string,
  ): Promise<RunnerResult> {
    this.calls.push({ packet, machine: machine.id, key });
    const result = this.results.shift();
    if (result instanceof Error) throw result;
    return (
      result ?? { exitCode: 0, commits: ["echo-commit"], stdout: packet.prompt }
    );
  }
}
