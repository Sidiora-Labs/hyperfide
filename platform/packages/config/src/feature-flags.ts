import type { FeatureFlags } from "@bb/domain";
import {
  readEnvVarWithDefault,
  resolveEnvLoader,
  type EnvLoaderArgs,
} from "./env.js";
import {
  HYPERFIDE_FF_PLACEHOLDER_ENV,
  HYPERFIDE_FF_TIMELINE_WINDOW_EVENT_BUDGET_ENV,
  HYPERFIDE_FF_INITIATOR_TELEMETRY_ENV,
  DEFAULT_HYPERFIDE_FF_PLACEHOLDER,
  DEFAULT_HYPERFIDE_FF_TIMELINE_WINDOW_EVENT_BUDGET,
  DEFAULT_HYPERFIDE_FF_INITIATOR_TELEMETRY,
} from "./env-vars.js";

type LoadFeatureFlagsArgs = EnvLoaderArgs;

export function loadFeatureFlags(
  args: LoadFeatureFlagsArgs = {},
): FeatureFlags {
  const loader = resolveEnvLoader(args);
  return {
    placeholder: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_HYPERFIDE_FF_PLACEHOLDER,
      definition: HYPERFIDE_FF_PLACEHOLDER_ENV,
      env: loader.env,
    }),
    initiatorTelemetry: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_HYPERFIDE_FF_INITIATOR_TELEMETRY,
      definition: HYPERFIDE_FF_INITIATOR_TELEMETRY_ENV,
      env: loader.env,
    }),
    timelineWindowEventBudget: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_HYPERFIDE_FF_TIMELINE_WINDOW_EVENT_BUDGET,
      definition: HYPERFIDE_FF_TIMELINE_WINDOW_EVENT_BUDGET_ENV,
      env: loader.env,
    }),
  };
}
