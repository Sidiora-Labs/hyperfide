import {
  cliCommand,
  defineCli,
  defineRpcContract,
  PluginCliError,
  type HyperfidePluginApi,
  type PluginAiServiceStatus,
} from "@hyperfide/plugin-sdk";
import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  type Account,
  type AccountFetchInput,
  type AccountFetchOutput,
  type AccountStatus,
} from "./account-contract.js";
import { formatResetTime, formatUsage } from "./format.js";

export const HYPERFIDE_AI_SERVICE_ID = "hyperfide";
const COMPLETE_PATH = "/api/ai/v1/complete";
const TRANSCRIBE_PATH = "/api/ai/v1/transcribe";
const USAGE_PATH = "/api/ai/v1/usage";
const COMPLETE_TIMEOUT_MS = 7_000;
const TRANSCRIBE_TIMEOUT_MS = 65_000;
export const TRANSCRIBE_MAX_BYTES = 10 * 1024 * 1024;
const ENABLED_KEY = "enabled";
const HYPERFIDE_CLOUD_OFF_MESSAGE = "hyperfide cloud is off. Turn it on with `hyperfide ai on`.";
const SIGN_IN_MESSAGE = "Sign in to your Hyperfide account";
const ACCOUNT_DOWN_MESSAGE = "Hosted accounts are disabled";

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

const AUDIO_FORMATS_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};

const AUDIO_FORMATS_BY_EXTENSION: Record<string, string> = {
  webm: "webm",
  ogg: "ogg",
  oga: "ogg",
  opus: "ogg",
  mp4: "m4a",
  m4a: "m4a",
  aac: "aac",
  mp3: "mp3",
  wav: "wav",
  flac: "flac",
};

export function audioFormat(audio: File): string | null {
  const mime = audio.type.split(";")[0]?.trim().toLowerCase() ?? "";
  const byMime = AUDIO_FORMATS_BY_MIME[mime];
  if (byMime !== undefined) return byMime;
  const extension = audio.name.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_FORMATS_BY_EXTENSION[extension] ?? null;
}

const completeResponseSchema = z.object({
  text: z.string(),
  model: z.string(),
  usage: z.object({
    costMicros: z.number().nonnegative(),
    spentTodayMicros: z.number().nonnegative(),
    limitMicros: z.number().nonnegative(),
  }),
});

export const usageSchema = z.object({
  day: z.string(),
  spentMicros: z.number().nonnegative(),
  limitMicros: z.number().nonnegative(),
  resetsAt: z.number(),
});
export type HyperfideAiUsage = z.infer<typeof usageSchema>;

const gatewayErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    resetsAt: z.number().optional(),
  }),
});

const statusViewSchema = z.discriminatedUnion("ready", [
  z.object({ ready: z.literal(true) }),
  z.object({ ready: z.literal(false), message: z.string() }),
]);

const overviewSchema = z.object({
  enabled: z.boolean(),
  account: z.discriminatedUnion("state", [
    z.object({ state: z.literal("unavailable") }),
    z.object({ state: z.literal("signed-out") }),
    z.object({
      state: z.literal("signed-in"),
      githubLogin: z.string().nullable(),
      name: z.string(),
    }),
  ]),
  status: statusViewSchema,
  usage: usageSchema.nullable(),
  usageError: z.string().nullable(),
});
export type HyperfideAiOverview = z.infer<typeof overviewSchema>;

export const hyperfideAiRpcContract = defineRpcContract({
  overview: { input: z.null(), output: overviewSchema },
  setEnabled: {
    experimental_description:
      "Turn hyperfide cloud on or off. While off, hyperfide cloud reports not ready and sends nothing to the retired hosted service.",
    input: z.object({ enabled: z.boolean() }).strict(),
    output: overviewSchema,
  },
});

const OFF_STATUS: PluginAiServiceStatus = {
  ready: false,
  message: HYPERFIDE_CLOUD_OFF_MESSAGE,
};

interface Exhaustion {
  accountKey: string;
  until: number;
}

interface GatewayFailure {
  message: string;
  resetsAt: number | null;
}

function accountKey(account: Account): string {
  return JSON.stringify([account.baseUrl, account.userId]);
}

function gatewayFailure(response: AccountFetchOutput): GatewayFailure {
  if (response.status === 401) {
    return { message: SIGN_IN_MESSAGE, resetsAt: null };
  }
  const parsed = gatewayErrorSchema.safeParse(response.body);
  if (!parsed.success) {
    return {
      message: `hyperfide cloud answered HTTP ${response.status}`,
      resetsAt: null,
    };
  }
  const { code, message, resetsAt } = parsed.data.error;
  return {
    message,
    resetsAt: code === "budget_exhausted" ? (resetsAt ?? null) : null,
  };
}

function limitReachedMessage(until: number): string {
  return `Daily limit reached; resets ${formatResetTime(until)} UTC`;
}

export default async function plugin(hyperfide: HyperfidePluginApi): Promise<void> {
  const stored = z
    .boolean()
    .safeParse(await hyperfide.storage.kv.get<unknown>(ENABLED_KEY));
  let enabled = stored.success ? stored.data : true;
  let exhaustion: Exhaustion | null = null;

  async function accountStatus(): Promise<AccountStatus | null> {
    return null;
  }

  async function currentAccountKey(): Promise<string | null> {
    const current = await accountStatus();
    return current?.signedIn === true ? accountKey(current.account) : null;
  }

  function accountFetch(
    _input: AccountFetchInput,
    _signal?: AbortSignal,
  ): Promise<AccountFetchOutput> {
    return Promise.reject(new Error("Hosted accounts are disabled"));
  }

  function exhaustedUntil(key: string): number | null {
    if (exhaustion === null || exhaustion.accountKey !== key) return null;
    return exhaustion.until > Date.now() ? exhaustion.until : null;
  }

  function statusFor(account: AccountStatus | null): PluginAiServiceStatus {
    if (account === null)
      return { ready: false, message: ACCOUNT_DOWN_MESSAGE };
    if (!account.signedIn) return { ready: false, message: SIGN_IN_MESSAGE };
    const until = exhaustedUntil(accountKey(account.account));
    if (until !== null) {
      return { ready: false, message: limitReachedMessage(until) };
    }
    return { ready: true };
  }

  async function status(): Promise<PluginAiServiceStatus> {
    if (!enabled) return OFF_STATUS;
    return statusFor(await accountStatus());
  }

  async function generate(
    path: string,
    body: () => Promise<AccountFetchInput["body"]>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<string> {
    if (!enabled) throw new Error(HYPERFIDE_CLOUD_OFF_MESSAGE);
    const account = await accountStatus();
    if (account === null) throw new Error(ACCOUNT_DOWN_MESSAGE);
    if (!account.signedIn) throw new Error(SIGN_IN_MESSAGE);
    const key = accountKey(account.account);
    const until = exhaustedUntil(key);
    if (until !== null) throw new Error(limitReachedMessage(until));
    const payload = await body();
    if (!enabled) throw new Error(HYPERFIDE_CLOUD_OFF_MESSAGE);
    const response = await accountFetch(
      { target: "api", method: "POST", path, body: payload, timeoutMs },
      signal,
    );
    if (response.status !== 200) {
      const failure = gatewayFailure(response);
      if (failure.resetsAt !== null && (await currentAccountKey()) === key) {
        exhaustion = { accountKey: key, until: failure.resetsAt };
      }
      throw new Error(failure.message);
    }
    const parsed = completeResponseSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new Error("hyperfide cloud returned an invalid reply");
    }
    return parsed.data.text;
  }

  function complete(prompt: string, signal: AbortSignal): Promise<string> {
    return generate(
      COMPLETE_PATH,
      async () => ({ prompt }),
      COMPLETE_TIMEOUT_MS,
      signal,
    );
  }

  function transcribe(
    audio: File,
    hint: string | null,
    signal: AbortSignal,
  ): Promise<string> {
    if (audio.size > TRANSCRIBE_MAX_BYTES) {
      return Promise.reject(
        new Error(
          `Recordings over ${TRANSCRIBE_MAX_BYTES / (1024 * 1024)} MB are too large for hyperfide cloud`,
        ),
      );
    }
    const format = audioFormat(audio);
    if (format === null) {
      return Promise.reject(
        new Error(
          `hyperfide cloud can't transcribe ${audio.type || "this"} audio; use WebM, Ogg, MP4, MP3, WAV, FLAC, or AAC`,
        ),
      );
    }
    return generate(
      TRANSCRIBE_PATH,
      async () => ({
        audio: Buffer.from(await audio.arrayBuffer()).toString("base64"),
        format,
        hint,
      }),
      TRANSCRIBE_TIMEOUT_MS,
      signal,
    );
  }

  async function usage(): Promise<HyperfideAiUsage> {
    const response = await accountFetch({
      target: "api",
      method: "GET",
      path: USAGE_PATH,
      body: null,
    });
    if (response.status !== 200) {
      throw new Error(gatewayFailure(response).message);
    }
    const parsed = usageSchema.safeParse(response.body);
    if (!parsed.success) {
      throw new Error("hyperfide cloud returned an invalid usage report");
    }
    return parsed.data;
  }

  async function overview(): Promise<HyperfideAiOverview> {
    const account = await accountStatus();
    let usageView: HyperfideAiUsage | null = null;
    let usageError: string | null = null;
    if (enabled && account?.signedIn === true) {
      try {
        usageView = await usage();
      } catch (error) {
        usageError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      enabled,
      account:
        account === null
          ? { state: "unavailable" }
          : account.signedIn
            ? {
                state: "signed-in",
                githubLogin: account.account.githubLogin,
                name: account.account.name,
              }
            : { state: "signed-out" },
      status: enabled ? statusFor(account) : OFF_STATUS,
      usage: usageView,
      usageError,
    };
  }

  async function setEnabled(next: boolean): Promise<HyperfideAiOverview> {
    await hyperfide.storage.kv.set(ENABLED_KEY, next);
    enabled = next;
    return overview();
  }

  hyperfide.experimental_aiServices.register({
    id: HYPERFIDE_AI_SERVICE_ID,
    displayName: "hyperfide cloud",
    complete: (prompt, { signal }) => complete(prompt, signal),
    transcribe: (audio, { signal, hint }) => transcribe(audio, hint, signal),
    status,
  });

  hyperfide.rpc.register(hyperfideAiRpcContract, {
    overview,
    setEnabled: ({ enabled: next }, context) => {
      if (context.experimental_caller.kind !== "client") {
        throw new Error(
          "only you can turn hyperfide cloud on or off, with `hyperfide ai on|off`",
        );
      }
      return setEnabled(next);
    },
  });

  hyperfide.cli.register(
    defineCli({
      name: "ai",
      summary:
        "Manage hyperfide cloud AI for titles, commit messages, and voice input",
      description: `hyperfide cloud writes thread titles and commit messages and transcribes voice input for signed-in hyperfide accounts. It is on by default; turn it off with \`hyperfide ai off\`. Choose which tasks use it with \`hyperfide settings ai-services set\`.`,
      commands: {
        status: cliCommand({
          summary: "Show whether hyperfide cloud is on and ready, and today's usage",
          options: { json: JSON_OPTION },
          async run(input) {
            const view = await overview();
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(view) };
            }
            const account =
              view.account.state === "signed-in"
                ? `Signed in as ${view.account.githubLogin ?? view.account.name}`
                : view.account.state === "signed-out"
                  ? "Signed out. Run `hyperfide account login`."
                  : "The hyperfide account plugin is not running.";
            const ready = view.status.ready
              ? "Ready"
              : `Not ready: ${view.status.message}`;
            const usageLine =
              view.usage !== null
                ? `Usage: ${formatUsage(view.usage)}`
                : view.usageError !== null
                  ? `Usage unavailable: ${view.usageError}`
                  : null;
            return {
              exitCode: 0,
              stdout: [account, ready, usageLine]
                .filter((line) => line !== null)
                .join("\n"),
            };
          },
        }),
        on: cliCommand({
          summary:
            "Turn hyperfide cloud on for thread titles, commit messages, and voice input",
          options: { json: JSON_OPTION },
          async run(input) {
            const view = await setEnabled(true);
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(view) };
            }
            return {
              exitCode: 0,
              stdout: view.status.ready
                ? "hyperfide cloud is on and ready for thread titles, commit messages, and voice input."
                : `hyperfide cloud is on but not ready: ${view.status.message}`,
            };
          },
        }),
        off: cliCommand({
          summary:
            "Turn hyperfide cloud off; hyperfide sends nothing to the retired hosted service",
          options: { json: JSON_OPTION },
          async run(input) {
            const view = await setEnabled(false);
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(view)
                : "hyperfide cloud is off. hyperfide no longer sends prompts or diffs to the retired hosted service. Run `hyperfide ai on` to turn it back on.",
            };
          },
        }),
        usage: cliCommand({
          summary: "Show today's hyperfide cloud spend against the daily limit",
          options: { json: JSON_OPTION },
          async run(input) {
            const account = await accountStatus();
            if (account?.signedIn !== true) {
              throw new PluginCliError("Not signed in to a hyperfide account", {
                code: "signed_out",
                hint: "Run `hyperfide account login`.",
              });
            }
            const current = await usage();
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify(current)
                : formatUsage(current),
            };
          },
        }),
      },
    }),
  );
}
