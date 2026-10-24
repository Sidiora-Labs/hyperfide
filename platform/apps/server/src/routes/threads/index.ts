import type { Hono } from "hono";
import type { AppDeps } from "../../types.js";
import { registerThreadActionRoutes } from "./actions.js";
import { registerThreadBaseRoutes } from "./base.js";
import { registerThreadDataRoutes } from "./data.js";
import { registerThreadInteractionRoutes } from "./interactions.js";
import { registerThreadTabRoutes } from "./tabs.js";
import { registerThreadImportRoutes } from "./import.js";

export function registerThreadRoutes(app: Hono, deps: AppDeps): void {
  registerThreadImportRoutes(app, deps);
  registerThreadBaseRoutes(app, deps);
  registerThreadActionRoutes(app, deps);
  registerThreadDataRoutes(app, deps);
  registerThreadInteractionRoutes(app, deps);
  registerThreadTabRoutes(app, deps);
}
