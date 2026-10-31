import type { HostDaemonSkillTree } from "@hyperfide/host-daemon-contract";

export type FetchSkillTree = (treeHash: string) => Promise<HostDaemonSkillTree>;
