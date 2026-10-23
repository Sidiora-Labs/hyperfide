export interface SpecCliOptions {
  binary?: string;
  serverUrl?: string;
  boardUrl?: string;
}
export interface SpecCliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}
export interface SpecCliRegistration {
  name: string;
  summary: string;
  rendersHelp: boolean;
  commands: { name: string; summary: string; usage: string }[];
  run(argv: string[], ctx?: { cwd?: string; signal?: AbortSignal }): Promise<SpecCliResult>;
}
export function createSpecCli(options?: SpecCliOptions): SpecCliRegistration;
export function registerSpecCli(ctx: { cli: { register(value: SpecCliRegistration): void } }, options?: SpecCliOptions): void;
