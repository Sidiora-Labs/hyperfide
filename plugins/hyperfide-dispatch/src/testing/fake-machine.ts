import type { SandboxMachine, SandboxMachineOps } from "../machine-ops";
type ExecResult = Awaited<ReturnType<SandboxMachine["exec"]>>;
export class FakeMachineProvider implements SandboxMachineOps {
  providerId = "hyperfide-fake";
  capabilities = { checkpoint: true, list: true };
  machines = new Map<string, FakeMachine>();
  checkpoints = new Map<string, Map<string, Uint8Array>>();
  execLog: {
    id: string;
    command: string;
    options: Parameters<SandboxMachine["exec"]>[1];
  }[] = [];
  scripts: {
    pattern: RegExp;
    result: Partial<ExecResult>;
    files?: Record<string, string>;
  }[] = [];
  failOnExec?: number;
  async create(
    options: Parameters<SandboxMachineOps["create"]>[0] = {},
  ): Promise<FakeMachine> {
    const source = options.fromCheckpoint
      ? this.checkpoints.get(options.fromCheckpoint)
      : undefined;
    if (options.fromCheckpoint && !source)
      throw new Error(`Unknown checkpoint: ${options.fromCheckpoint}`);
    const machine = new FakeMachine(
      `machine-${this.machines.size + 1}`,
      this,
      options.name,
    );
    for (const [path, bytes] of source ?? [])
      machine.files.set(path, bytes.slice());
    this.machines.set(machine.id, machine);
    return machine;
  }
  async connect(id: string): Promise<FakeMachine> {
    const machine = this.machines.get(id);
    if (!machine || machine.destroyed)
      throw new Error(`Unknown machine: ${id}`);
    return machine;
  }
  async list() {
    return [...this.machines.values()]
      .filter((m) => !m.destroyed)
      .map((m) => ({ id: m.id, name: m.name, status: "running" }));
  }
}
export class FakeMachine implements SandboxMachine {
  files = new Map<string, Uint8Array>();
  checkpointNames: string[] = [];
  destroyed = false;
  constructor(
    public id: string,
    private provider: FakeMachineProvider,
    public name?: string,
  ) {}
  private active() {
    if (this.destroyed) throw new Error(`Machine destroyed: ${this.id}`);
  }
  async exec(
    command: string,
    options: Parameters<SandboxMachine["exec"]>[1] = {},
  ): Promise<ExecResult> {
    this.active();
    this.provider.execLog.push({ id: this.id, command, options });
    if (this.provider.execLog.length === this.provider.failOnExec)
      throw new Error("Injected machine exec failure");
    const script = this.provider.scripts.find((s) => {
      s.pattern.lastIndex = 0;
      return s.pattern.test(command);
    });
    for (const [path, text] of Object.entries(script?.files ?? {}))
      this.files.set(path, Buffer.from(text));
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
      truncated: false,
      ms: 0,
      ...script?.result,
    };
  }
  async readFile(path: string) {
    this.active();
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`Missing file: ${path}`);
    return bytes.slice();
  }
  async writeFile(path: string, bytes: Uint8Array) {
    this.active();
    this.files.set(path, bytes.slice());
  }
  async checkpoint(name: string) {
    this.active();
    this.checkpointNames.push(name);
    this.provider.checkpoints.set(
      name,
      new Map([...this.files].map(([path, bytes]) => [path, bytes.slice()])),
    );
    return { name };
  }
  async destroy() {
    this.destroyed = true;
  }
}
