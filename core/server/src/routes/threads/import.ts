import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@hyperfide/server-contract";
import type { Hono } from "hono";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import {
  discoverImportSources,
  importSessions,
} from "../../services/threads/thread-import/service.js";

export function registerThreadImportRoutes(app: Hono, deps: AppDeps): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  get(publicApiRoutes.threads.importSources, async (context, query) =>
    context.json(await discoverImportSources(query)),
  );
  post(publicApiRoutes.threads.import, async (context, payload) =>
    context.json(await importSessions(deps, payload)),
  );
}
