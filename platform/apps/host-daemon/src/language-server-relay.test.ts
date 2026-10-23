import { createServer } from "node:http";
import { mkdtemp, writeFile, chmod, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { WebSocket } from "ws";
import { expect, it } from "vitest";
import { attachLanguageServerRelay } from "./language-server-relay.js";

it("relays initialize and definitions, shares the repository process and stops after idle", async () => {
  const directory = await mkdtemp(`${tmpdir()}/hyperfide-lsp-`);
  const root = await realpath(directory);
  const binary = `${root}/language-server`;
  await writeFile(
    binary,
    `#!${process.execPath}
let buffer = Buffer.alloc(0);
let output = Promise.resolve();
process.stdin.on('data', chunk => {
 buffer = Buffer.concat([buffer, chunk]);
 while (true) {
 const end = buffer.indexOf('\\r\\n\\r\\n'); if (end < 0) return;
 const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0,end).toString())[1]);
 if (buffer.length < end+4+length) return;
 const message = JSON.parse(buffer.subarray(end+4,end+4+length)); buffer = buffer.subarray(end+4+length);
 if (message.id === undefined) continue;
 const result = message.method === 'initialize' ? {capabilities:{definitionProvider:true},pid:process.pid} : [{uri:'file:///test.c',range:{start:{line:2,character:0},end:{line:2,character:4}}}];
 const body = JSON.stringify({jsonrpc:'2.0',id:message.id,result});
 const frame = 'Content-Length: '+Buffer.byteLength(body)+'\\r\\n\\r\\n'+body;
 output = output.then(() => new Promise(resolve => { process.stdout.write(frame.slice(0,7)); setTimeout(()=>{process.stdout.write(frame.slice(7));resolve();},2); }));
 }
});
`,
  );
  await chmod(binary, 0o755);
  const server = createServer();
  const relay = attachLanguageServerRelay(server, {
    binary,
    idleMs: 250,
    allowOrigin: async (origin) => origin === "http://hyperfide.test",
  });
  const clients: WebSocket[] = [];
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as { port: number };
    const connect = async () => {
      const client = new WebSocket(
        `ws://127.0.0.1:${address.port}/language-server?repository=${encodeURIComponent(root)}`,
        { headers: { Origin: "http://hyperfide.test" } },
      );
      clients.push(client);
      await once(client, "open");
      return client;
    };
    const request = async (client: WebSocket, method: string) => {
      const response = once(client, "message");
      client.send(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
      );
      return JSON.parse((await response)[0].toString());
    };
    const first = await connect();
    const initialized = await request(first, "initialize");
    expect(initialized.result.capabilities.definitionProvider).toBe(true);
    const second = await connect();
    expect((await request(second, "initialize")).result.pid).toBe(
      initialized.result.pid,
    );
    const definitions = await Promise.all([
      request(first, "textDocument/definition"),
      request(second, "textDocument/definition"),
    ]);
    expect(definitions[0].id).toBe(1);
    expect(definitions[1].result[0].uri).toBe("file:///test.c");
    expect(relay.status(root)).toBe("running");
    await once(first, "close");
    expect(relay.status(root)).toBe("stopped");
    await expect
      .poll(() => {
        try {
          process.kill(initialized.result.pid, 0);
          return true;
        } catch {
          return false;
        }
      })
      .toBe(false);
  } finally {
    for (const client of clients) client.terminate();
    relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("closes quietly when the language-server binary is missing", async () => {
  const server = createServer();
  const root = await realpath(tmpdir());
  const relay = attachLanguageServerRelay(server, {
    binary: "/missing/hyperfide",
    allowOrigin: async () => true,
  });
  let client: WebSocket | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as { port: number };
    client = new WebSocket(
      `ws://127.0.0.1:${port}/language-server?repository=${encodeURIComponent(root)}`,
      { headers: { Origin: "http://hyperfide.test" } },
    );
    await once(client, "close");
    expect(relay.status(root)).toBe("stopped");
  } finally {
    client?.terminate();
    relay.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
