import type * as Monaco from "monaco-editor";

type Rpc = (method: string, params: unknown) => Promise<any>;

export function languageProviders(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  request: Rpc,
  documentUri = model.uri.toString(),
) {
  const positionParams = (position: Monaco.Position) => ({
    textDocument: { uri: documentUri },
    position: { line: position.lineNumber - 1, character: position.column - 1 },
  });
  const range = (value: any) => ({
    startLineNumber: value.start.line + 1,
    startColumn: value.start.character + 1,
    endLineNumber: value.end.line + 1,
    endColumn: value.end.character + 1,
  });
  const locations = (value: any) =>
    (value == null ? [] : Array.isArray(value) ? value : [value]).map(
      (entry: any) => ({
        uri: monaco.Uri.parse(entry.uri ?? entry.targetUri),
        range: range(entry.range ?? entry.targetSelectionRange),
      }),
    );
  const selector = {
    language: model.getLanguageId(),
    scheme: model.uri.scheme,
    pattern: model.uri.path,
  };
  return [
    monaco.languages.registerDefinitionProvider(selector, {
      provideDefinition: async (_, position) =>
        locations(
          await request("textDocument/definition", positionParams(position)),
        ),
    }),
    monaco.languages.registerReferenceProvider(selector, {
      provideReferences: async (_, position, context) =>
        locations(
          await request("textDocument/references", {
            ...positionParams(position),
            context,
          }),
        ),
    }),
    monaco.languages.registerHoverProvider(selector, {
      provideHover: async (_, position) => {
        const result = await request(
          "textDocument/hover",
          positionParams(position),
        );
        if (!result) return null;
        const content = Array.isArray(result.contents)
          ? result.contents
          : [result.contents];
        return {
          contents: content.map((item: any) => ({
            value: typeof item === "string" ? item : item.value,
          })),
          ...(result.range ? { range: range(result.range) } : {}),
        };
      },
    }),
  ];
}

export function connectLanguageClient(
  monaco: typeof Monaco,
  model: Monaco.editor.ITextModel,
  endpoint: string,
  root: string,
  documentUri = model.uri.toString(),
) {
  const socket = new WebSocket(endpoint);
  let nextId = 0;
  let disposed = false;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const disposables: Array<{ dispose(): void }> = [];
  const notify = (method: string, params: unknown) => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  };
  const request: Rpc = (method, params) =>
    new Promise((resolve) => {
      if (socket.readyState !== WebSocket.OPEN) {
        resolve(null);
        return;
      }
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(null);
      }, 10_000);
      pending.set(id, { resolve, timer });
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      const entry = pending.get(message.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(message.id);
        entry.resolve(message.result ?? null);
      }
    } catch {
      /* An unavailable server leaves the editor's built-in features active. */
    }
  };
  const textDocument = () => ({
    uri: documentUri,
    languageId: model.getLanguageId(),
    version: model.getVersionId(),
    text: model.getValue(),
  });
  socket.onopen = async () => {
    const initialized = await request("initialize", {
      processId: null,
      rootUri: root,
      capabilities: {},
    });
    if (!initialized || disposed) return;
    notify("initialized", {});
    notify("textDocument/didOpen", { textDocument: textDocument() });
    disposables.push(...languageProviders(monaco, model, request, documentUri));
    disposables.push(
      model.onDidChangeContent(() =>
        notify("textDocument/didChange", {
          textDocument: {
            uri: documentUri,
            version: model.getVersionId(),
          },
          contentChanges: [{ text: model.getValue() }],
        }),
      ),
    );
  };
  const cleanup = () => {
    for (const disposable of disposables.splice(0)) disposable.dispose();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    pending.clear();
  };
  socket.onclose = cleanup;
  socket.onerror = () => {
    cleanup();
    socket.close();
  };
  return {
    dispose() {
      disposed = true;
      notify("textDocument/didClose", {
        textDocument: { uri: documentUri },
      });
      cleanup();
      socket.close();
    },
  };
}
