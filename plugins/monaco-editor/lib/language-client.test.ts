import { expect, it, vi } from "vitest";
import { languageProviders, connectLanguageClient } from "./language-client.js";

it("maps definitions, references and hover between Monaco and LSP coordinates", async () => {
  const providers: Record<string, any> = {};
  const monaco = {
    Uri: { parse: (uri: string) => uri },
    languages: {
      registerDefinitionProvider: (_: unknown, provider: unknown) => {
        providers.definition = provider;
        return { dispose() {} };
      },
      registerReferenceProvider: (_: unknown, provider: unknown) => {
        providers.references = provider;
        return { dispose() {} };
      },
      registerHoverProvider: (_: unknown, provider: unknown) => {
        providers.hover = provider;
        return { dispose() {} };
      },
    },
  };
  const model = {
    getLanguageId: () => "c",
    uri: {
      toString: () => "file:///repo/a.c",
      scheme: "file",
      path: "/repo/a.c",
    },
  };
  const range = {
    start: { line: 2, character: 3 },
    end: { line: 2, character: 7 },
  };
  const request = vi.fn(async (method: string) =>
    method.endsWith("hover")
      ? { contents: { kind: "markdown", value: "symbol" }, range }
      : [{ uri: "file:///repo/b.c", range }],
  );
  languageProviders(monaco as any, model as any, request);
  const position = { lineNumber: 4, column: 6 };
  expect(
    (await providers.definition.provideDefinition(model, position))[0].range
      .startLineNumber,
  ).toBe(3);
  await providers.references.provideReferences(model, position, {
    includeDeclaration: true,
  });
  expect(request).toHaveBeenCalledWith("textDocument/references", {
    textDocument: { uri: "file:///repo/a.c" },
    position: { line: 3, character: 5 },
    context: { includeDeclaration: true },
  });
  expect(
    (await providers.hover.provideHover(model, position)).contents,
  ).toEqual([{ value: "symbol" }]);
});

it("silently handles a missing server and releases the socket", () => {
  class Socket {
    static OPEN = 1;
    readyState = 0;
    onerror?: () => void;
    close = vi.fn();
    constructor() {
      socket = this;
    }
  }
  let socket: Socket;
  vi.stubGlobal("WebSocket", Socket);
  const client = connectLanguageClient(
    {} as any,
    { uri: { toString: () => "file:///repo/a.c" } } as any,
    "ws://localhost/language-server",
    "file:///repo",
  );
  socket!.onerror!();
  client.dispose();
  expect(socket!.close).toHaveBeenCalled();
  vi.unstubAllGlobals();
});

it("initializes, opens and updates the document, then disposes providers", async () => {
  const sent: any[] = [];
  const dispose = vi.fn();
  let changed: () => void = () => {};
  let socket: any;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onmessage?: (event: { data: string }) => void;
    close = vi.fn();
    constructor() {
      socket = this;
    }
    send(body: string) {
      const message = JSON.parse(body);
      sent.push(message);
      if (message.id)
        queueMicrotask(() =>
          this.onmessage?.({
            data: JSON.stringify({
              id: message.id,
              result: { capabilities: {} },
            }),
          }),
        );
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const monaco = {
    languages: Object.fromEntries(
      ["Definition", "Reference", "Hover"].map((name) => [
        `register${name}Provider`,
        () => ({ dispose }),
      ]),
    ),
  };
  const model = {
    uri: {
      toString: () => "file:///repo/a.c",
      scheme: "file",
      path: "/repo/a.c",
    },
    getLanguageId: () => "c",
    getVersionId: () => 1,
    getValue: () => "int main();",
    onDidChangeContent: (callback: () => void) => {
      changed = callback;
      return { dispose };
    },
  };
  const client = connectLanguageClient(
    monaco as any,
    model as any,
    "ws://localhost",
    "file:///repo",
  );
  try {
    await socket.onopen();
    changed();
    expect(sent.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "textDocument/didChange",
    ]);
    expect(sent[2].params.textDocument.uri).toBe("file:///repo/a.c");
    client.dispose();
    expect(sent.at(-1).method).toBe("textDocument/didClose");
    expect(dispose).toHaveBeenCalledTimes(4);
  } finally {
    client.dispose();
    vi.unstubAllGlobals();
  }
});
