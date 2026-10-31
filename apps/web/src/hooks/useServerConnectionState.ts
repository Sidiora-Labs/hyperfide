import { useSyncExternalStore } from "react";
import { wsManager, type WebSocketConnectionState } from "@/lib/ws";

type StoreChangeCallback = () => void;

function subscribeServerConnectionState(
  onStoreChange: StoreChangeCallback,
): () => void {
  return wsManager.onConnectionStateChange(onStoreChange);
}

function getServerConnectionStateSnapshot(): WebSocketConnectionState {
  return wsManager.getConnectionState();
}

export function useServerConnectionState(): WebSocketConnectionState {
  return useSyncExternalStore(
    subscribeServerConnectionState,
    getServerConnectionStateSnapshot,
    getServerConnectionStateSnapshot,
  );
}
