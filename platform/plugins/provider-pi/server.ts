import type { HyperfidePluginApi } from "@hyperfide/plugin-sdk";
import { piProviderDeclaration } from "./src/declaration.js";

export default function plugin(hyperfide: HyperfidePluginApi): void {
  const registered = hyperfide.providers.register(piProviderDeclaration());
  hyperfide.onDispose(() => {
    registered.dispose();
  });
}
