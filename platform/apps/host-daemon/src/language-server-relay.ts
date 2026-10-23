import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

const MAX_BYTES = 8 * 1024 * 1024;
type Session = {
  child: ChildProcessWithoutNullStreams;
  clients: Set<WebSocket>;
  pending: Map<number, { socket: WebSocket; id: unknown }>;
  nextId: number;
  buffer: Buffer;
  timer: ReturnType<typeof setTimeout>;
  initialized?: unknown;
  initializeId?: number;
  didInitialize?: boolean;
  waiters: Array<{ socket: WebSocket; id: unknown }>;
};

export function attachLanguageServerRelay(
  server: Server,
  options: {
    allowOrigin: (origin: string, url: string) => Promise<boolean>;
    binary?: string;
    idleMs?: number;
  },
) {
  const sessions = new Map<string, Session>();
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BYTES,
  });
  const status = (repository: string) =>
    sessions.has(repository) ? "running" : "stopped";
  function stop(root: string, session: Session) {
    if (sessions.get(root) !== session) return;
    sessions.delete(root);
    clearTimeout(session.timer);
    session.child.kill();
    const killTimer = setTimeout(() => session.child.kill("SIGKILL"), 1000);
    killTimer.unref();
    session.child.once("exit", () => clearTimeout(killTimer));
    for (const client of session.clients)
      client.close(1001, "Language server stopped");
  }
  function touch(root: string, session: Session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(
      () => stop(root, session),
      options.idleMs ?? 60_000,
    );
    session.timer.unref();
  }
  function write(session: Session, message: unknown) {
    const body = JSON.stringify(message);
    session.child.stdin.write(
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  }
  function connect(root: string, socket: WebSocket) {
    let session = sessions.get(root);
    if (!session) {
      const child = spawn(options.binary ?? "hyperfide", ["lsp"], {
        cwd: root,
        stdio: "pipe",
      });
      session = {
        child,
        clients: new Set(),
        pending: new Map(),
        nextId: 0,
        waiters: [],
        buffer: Buffer.alloc(0),
        timer: setTimeout(() => {}, 0),
      };
      sessions.set(root, session);
      const current = session;
      child.stderr.resume();
      child.on("error", () => stop(root, current));
      child.on("exit", () => stop(root, current));
      child.stdin.on("error", () => stop(root, current));
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          current.buffer = Buffer.concat([current.buffer, chunk]);
          while (true) {
            const end = current.buffer.indexOf("\r\n\r\n");
            if (end < 0) {
              if (current.buffer.length > MAX_BYTES)
                throw new Error("Header too large");
              break;
            }
            const length = Number(
              /Content-Length:\s*(\d+)/i.exec(
                current.buffer.subarray(0, end).toString(),
              )?.[1],
            );
            if (
              !Number.isSafeInteger(length) ||
              length < 0 ||
              length > MAX_BYTES
            )
              throw new Error("Invalid frame");
            if (current.buffer.length < end + 4 + length) break;
            const message = JSON.parse(
              current.buffer.subarray(end + 4, end + 4 + length).toString(),
            );
            current.buffer = current.buffer.subarray(end + 4 + length);
            if (
              current.initializeId !== undefined &&
              message.id === current.initializeId &&
              current.initialized === undefined
            ) {
              current.initialized = message;
              for (const waiter of current.waiters)
                if (waiter.socket.readyState === WebSocket.OPEN)
                  waiter.socket.send(
                    JSON.stringify({ ...message, id: waiter.id }),
                  );
              current.waiters = [];
            }
            const pending = current.pending.get(message.id);
            if (pending) {
              current.pending.delete(message.id);
              if (pending.socket.readyState === WebSocket.OPEN)
                pending.socket.send(
                  JSON.stringify({ ...message, id: pending.id }),
                );
            } else if (message.id === undefined) {
              for (const client of current.clients)
                if (client.readyState === WebSocket.OPEN)
                  client.send(JSON.stringify(message));
            }
          }
        } catch {
          stop(root, current);
        }
      });
    }
    const current = session;
    current.clients.add(socket);
    touch(root, current);
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.jsonrpc !== "2.0" || typeof message.method !== "string")
          throw new Error("Invalid request");
        touch(root, current);
        // Each editor owns a JSON-RPC id space; the process owns a separate one.
        if (message.method === "shutdown" || message.method === "exit") {
          if (message.id !== undefined)
            socket.send(
              JSON.stringify({ jsonrpc: "2.0", id: message.id, result: null }),
            );
          return;
        }
        if (message.method === "initialized") {
          if (current.didInitialize) return;
          current.didInitialize = true;
        }
        if (message.method === "initialize") {
          if (current.initialized !== undefined) {
            socket.send(
              JSON.stringify({
                ...(current.initialized as object),
                id: message.id,
              }),
            );
            return;
          }
          if (current.initializeId !== undefined) {
            current.waiters.push({ socket, id: message.id });
            return;
          }
        }
        if (message.id !== undefined) {
          const id = ++current.nextId;
          if (message.method === "initialize") current.initializeId = id;
          current.pending.set(id, { socket, id: message.id });
          write(current, { ...message, id });
        } else write(current, message);
      } catch {
        socket.close(1008, "Invalid JSON-RPC");
      }
    });
    socket.on("close", () => {
      current.clients.delete(socket);
      current.waiters = current.waiters.filter(
        (waiter) => waiter.socket !== socket,
      );
      for (const [id, pending] of current.pending)
        if (pending.socket === socket) current.pending.delete(id);
    });
    socket.on("error", () => socket.close());
  }
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.pathname !== "/language-server") {
        socket.destroy();
        return;
      }
      const origin = request.headers.origin;
      if (!origin || !(await options.allowOrigin(origin, url.href))) {
        socket.destroy();
        return;
      }
      const repository = url.searchParams.get("repository");
      if (!repository) {
        socket.destroy();
        return;
      }
      const root = await realpath(repository);
      sockets.handleUpgrade(request, socket, head, (client) => {
        connect(root, client);
      });
    })().catch(() => socket.destroy());
  });
  return {
    status,
    close() {
      for (const [root, session] of sessions) stop(root, session);
      sockets.close();
    },
  };
}
