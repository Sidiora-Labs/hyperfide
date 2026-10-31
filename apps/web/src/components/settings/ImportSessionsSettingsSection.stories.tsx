import { ImportSessionsSettingsContent } from "./ImportSessionsSettingsSection";

const sources = [
  {
    source: "claude-code" as const,
    root: "/home/owner/.claude/projects",
    count: 9,
  },
  {
    source: "codex" as const,
    root: "/home/owner/.codex/sessions",
    count: 1035,
  },
];
const noop = () => {};

export const Discovered = () => (
  <ImportSessionsSettingsContent
    sources={sources}
    onImport={noop}
    onRefresh={noop}
  />
);
export const Importing = () => (
  <ImportSessionsSettingsContent
    sources={sources}
    importing
    onImport={noop}
    onRefresh={noop}
  />
);
export const Complete = () => (
  <ImportSessionsSettingsContent
    sources={sources}
    result={{ imported: 1044, updated: 0, records: 16842, errors: [] }}
    onImport={noop}
    onRefresh={noop}
  />
);
export const Failed = () => (
  <ImportSessionsSettingsContent
    sources={sources}
    error="Session import request failed (503)."
    onImport={noop}
    onRefresh={noop}
  />
);
