import { openPluginStorage } from '@hyperfide/authority';
export const openAskStorage = (repository: string) => openPluginStorage('hyperfide-asks', repository);
