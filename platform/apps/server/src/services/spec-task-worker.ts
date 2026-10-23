// Plugins are loaded at runtime rather than compiled into the server package.
// This projection loader disappears when the spec plugin registry (2.1) lands.
export async function loadSpecTaskWorker() {
  const entry = new URL("../../../../plugins/hyperfide-spec/src/worker.ts", import.meta.url).href;
  return import(entry);
}
