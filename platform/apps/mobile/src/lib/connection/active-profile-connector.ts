import type { ServerProfile } from "../profiles/profile";
import type { AppStateLike } from "../realtime/app-state";
import type {
  ProfileClient,
  ProfileClientRegistry,
} from "../sdk/client-registry";
import { connectProfileClient } from "../sdk/connect-profile-client";
import type { SessionState } from "../session/session-scheduler";

export interface ActiveProfileConnection {
  profile: ServerProfile;
  client: ProfileClient;
  session: SessionState;
}

export interface ActiveProfileConnector {
  activate(profile: ServerProfile | null): void;
  getSnapshot(): ActiveProfileConnection | null;
  subscribe(listener: () => void): () => void;
}

export interface CreateActiveProfileConnectorDeps {
  registry: ProfileClientRegistry;
  appState: AppStateLike;
}

const IDLE_SESSION: SessionState = { status: "idle" };

export const CONNECT_FAILURE_VERIFY_INTERVAL_MS = 30_000;
export const AUTH_FAILURE_VERIFY_DEBOUNCE_MS = 2000;
export const AUTH_FAILURE_REFETCH_DELAY_MS = 250;
export const AUTH_FAILURE_MAX_REMINTS = 3;
export const AUTH_FAILURE_STREAK_WINDOW_MS = 60_000;
export const AUTH_FAILURE_BREAKER_COOLDOWN_MS = 60_000;

function connectionIdentity(profile: ServerProfile): string {
  return profile.mode === "connect"
    ? `${profile.id}\0${profile.serverUrl}\0${profile.credential}`
    : `${profile.id}\0${profile.serverUrl}`;
}

export function createActiveProfileConnector(
  deps: CreateActiveProfileConnectorDeps,
): ActiveProfileConnector {
  const listeners = new Set<() => void>();
  let snapshot: ActiveProfileConnection | null = null;
  let identity: string | null = null;
  let teardown: (() => void) | null = null;

  function setSnapshot(next: ActiveProfileConnection | null): void {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function teardownCurrent(): void {
    const current = teardown;
    teardown = null;
    identity = null;
    current?.();
  }

  function activateDirect(profile: ServerProfile, client: ProfileClient): void {
    const disconnectRealtime = connectProfileClient(client, deps.appState);
    teardown = disconnectRealtime;
    setSnapshot({ profile, client, session: IDLE_SESSION });
  }

  return {
    activate(profile) {
      if (profile === null) {
        teardownCurrent();
        setSnapshot(null);
        return;
      }
      const nextIdentity = connectionIdentity(profile);
      if (identity === nextIdentity && snapshot) {
        if (snapshot.profile !== profile) setSnapshot({ ...snapshot, profile });
        return;
      }
      teardownCurrent();
      identity = nextIdentity;
      const client = deps.registry.getClientForProfile(profile);
      if (profile.mode === "connect") {
        setSnapshot({
          profile,
          client,
          session: {
            status: "error",
            detail:
              "Hosted connections are disabled. Add a server URL to connect directly.",
            retryAt: Infinity,
          },
        });
      } else {
        activateDirect(profile, client);
      }
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
