import {
  clientNotificationSchema,
  type ClientNotification,
} from "./contract.js";

export type ClientChannel = "web" | "desktop";

export function clientChannel(): ClientChannel | null {
  if ("hyperfideDesktop" in window) return "desktop";
  if (
    "hyperfide" in window &&
    typeof window.hyperfide === "object" &&
    window.hyperfide !== null &&
    "native" in window.hyperfide
  )
    return null;
  return "web";
}

export function notificationPermission():
  | NotificationPermission
  | "unsupported" {
  return typeof Notification === "undefined" || !window.isSecureContext
    ? "unsupported"
    : Notification.permission;
}

export function createClientDelivery(navigate: (threadId: string) => void) {
  const active = new Set<Notification>();
  let disposed = false;

  function display(message: ClientNotification): void {
    if (disposed || notificationPermission() !== "granted") return;
    const isMacDesktop =
      "hyperfideDesktop" in window &&
      typeof window.hyperfideDesktop === "object" &&
      window.hyperfideDesktop !== null &&
      "platform" in window.hyperfideDesktop &&
      window.hyperfideDesktop.platform === "macos";
    const notification = new Notification(message.title, {
      body: message.body,
      ...(isMacDesktop
        ? {}
        : { icon: new URL("/icon-192.png", window.location.origin).href }),
      tag: `hyperfide-${message.threadId ?? message.id}`,
    });
    active.add(notification);
    notification.onclose = () => active.delete(notification);
    notification.onclick = () => {
      if (disposed) return;
      window.focus();
      if (
        "hyperfideDesktop" in window &&
        typeof window.hyperfideDesktop === "object" &&
        window.hyperfideDesktop !== null &&
        "platform" in window.hyperfideDesktop &&
        window.hyperfideDesktop.platform === "linux" &&
        "focusWindow" in window.hyperfideDesktop &&
        typeof window.hyperfideDesktop.focusWindow === "function"
      ) {
        window.hyperfideDesktop.focusWindow();
      }
      if (message.threadId !== null) navigate(message.threadId);
      notification.close();
      active.delete(notification);
    };
  }

  async function deliver(payload: unknown, enabled: boolean): Promise<void> {
    const parsed = clientNotificationSchema.safeParse(payload);
    const channel = clientChannel();
    if (
      !enabled ||
      disposed ||
      channel === null ||
      !parsed.success ||
      !parsed.data.channels.includes(channel) ||
      notificationPermission() !== "granted"
    )
      return;
    const message = parsed.data;
    const claim = () => {
      if (disposed) return;
      const key = `hyperfide.push-notifications.seen.${channel}`;
      let ids: string[] = [];
      try {
        const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
        ids = Array.isArray(stored)
          ? stored.filter((id): id is string => typeof id === "string")
          : [];
        if (ids.includes(message.id)) return;
      } catch {
        ids = [];
      }
      display(message);
      try {
        localStorage.setItem(
          key,
          JSON.stringify([...ids.slice(-99), message.id]),
        );
      } catch {
        return;
      }
    };
    if (navigator.locks)
      await navigator.locks.request(`hyperfide-notifications-${channel}`, claim);
    else claim();
  }

  return {
    deliver,
    dispose() {
      disposed = true;
      for (const notification of active) notification.close();
      active.clear();
    },
  };
}
