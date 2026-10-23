import type { BbPluginApi } from "@hyperfide/plugin-sdk";
import { piProviderDeclaration } from "./src/declaration.js";

export default function plugin(bb: BbPluginApi): void {
  const registered = bb.providers.register(piProviderDeclaration());
  bb.onDispose(() => {
    registered.dispose();
  });
}
