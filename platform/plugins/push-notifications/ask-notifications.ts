import type { Ask, AskBridge } from "../hyperfide-asks/bridge-projection.js";

export interface AskNotificationState {
  sent: string[];
  pending: Ask[];
  digestAt: number;
}

export interface AskNotification {
  id: string;
  title: string;
  body: string;
}

export function createAskNotifications(args: {
  bridge: Pick<AskBridge, "list" | "policy">;
  read(): Promise<AskNotificationState | null>;
  write(state: AskNotificationState): Promise<void>;
  digestMinutes(): Promise<number>;
  send(notification: AskNotification): Promise<void>;
  now?: () => number;
}) {
  const now = args.now ?? Date.now;
  const key = (ask: Ask) => JSON.stringify([ask.repository, ask.id]);
  const detail = (ask: Ask) =>
    `${ask.task} | ${ask.kind} | deadline: ${ask.deadline ?? "none"}`;
  let active: Promise<void> | undefined;

  async function refresh() {
    const [{ asks }, policy, minutes] = await Promise.all([
      args.bridge.list(),
      args.bridge.policy(),
      args.digestMinutes(),
    ]);
    const state = (await args.read()) ?? {
      sent: [],
      pending: [],
      digestAt: now(),
    };
    const sent = new Set(state.sent);
    const open = asks.filter(
      (ask) => ask.status === "open" || ask.status === "expired",
    );
    const openKeys = new Set(open.map(key));
    state.pending = state.pending.filter((ask) => openKeys.has(key(ask)));
    for (const ask of open) {
      if (sent.has(key(ask))) continue;
      if (policy[ask.kind] === "block") {
        await args.send({
          id: key(ask),
          title: "Ask needs your answer",
          body: detail(ask),
        });
        sent.add(key(ask));
        state.pending = state.pending.filter(
          (entry) => key(entry) !== key(ask),
        );
        state.sent = [...sent];
        await args.write(state);
      } else if (
        policy[ask.kind] === "proceed-and-flag" &&
        !state.pending.some((entry) => key(entry) === key(ask))
      ) {
        if (state.pending.length === 0) state.digestAt = now();
        state.pending.push(ask);
      }
    }
    if (
      minutes > 0 &&
      state.pending.length > 0 &&
      now() - state.digestAt >= minutes * 60_000
    ) {
      await args.send({
        id: JSON.stringify(state.pending.map(key)),
        title: `${state.pending.length} flagged Asks`,
        body: state.pending.map(detail).join("\n"),
      });
      for (const ask of state.pending) sent.add(key(ask));
      state.pending = [];
      state.digestAt = now();
    }
    state.sent = [...sent];
    await args.write(state);
  }

  return {
    refresh() {
      // Watch refreshes and polling may overlap; serialize the durable dedupe.
      if (!active)
        active = refresh().finally(() => {
          active = undefined;
        });
      return active;
    },
  };
}
