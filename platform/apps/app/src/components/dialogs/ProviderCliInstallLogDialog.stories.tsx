import {
  ProviderCliInstallLogDialogContent,
  type ProviderCliInstallLogDialogState,
} from "./ProviderCliInstallLogDialog";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { DialogStage } from "../../../.ladle/story-dialog-stage";

export default {
  title: "dialogs/Provider CLI Install Log",
};

const codexUpdateLogState: ProviderCliInstallLogDialogState = {
  displayName: "Codex",
  title: "Codex update log",
  message: "Command exited with code 1",
  log: [
    "$ npm install -g @openai/codex",
    "npm ERR! code EACCES",
    "npm ERR! syscall mkdir",
    "npm ERR! path /usr/local/lib/node_modules/@openai",
    "npm ERR! errno -13",
    "npm ERR! Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/@openai'",
    "",
    "npm ERR! The operation was rejected by your operating system.",
    "npm ERR! It is likely you do not have permission to access this file as the current user.",
  ].join("\n"),
};

const claudeInstallLogState: ProviderCliInstallLogDialogState = {
  displayName: "Claude Code",
  title: "Claude Code install log",
  message: "Command exited after signal SIGTERM",
  log: [
    "$ npm install -g @anthropic-ai/claude-code",
    "npm WARN deprecated old-transitive-package@1.2.3: package is no longer maintained",
    "npm ERR! process terminated",
    "npm ERR! signal SIGTERM",
    "",
    "npm ERR! A complete log of this run can be found in:",
    "npm ERR! /Users/michael/.npm/_logs/2026-05-26T22_42_19_000Z-debug-0.log",
  ].join("\n"),
};

export function ViewLogDialog() {
  return (
    <StoryCard labelWidth="240px">
      <StoryRow
        label="Codex update failed"
        hint='Shown after clicking "View log" on the provider update failure toast.'
      >
        <DialogStage>
          <ProviderCliInstallLogDialogContent state={codexUpdateLogState} />
        </DialogStage>
      </StoryRow>
      <StoryRow
        label="Claude install failed"
        hint="Longer command output keeps the dialog scrollable and copyable."
      >
        <DialogStage>
          <ProviderCliInstallLogDialogContent state={claudeInstallLogState} />
        </DialogStage>
      </StoryRow>
    </StoryCard>
  );
}
