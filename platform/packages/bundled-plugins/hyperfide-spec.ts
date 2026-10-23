import { registerSpecReadModel } from '../../plugins/hyperfide-spec/src/read-model-server.js';

// Task 1.3's runtime registry can install this repository-scoped service.
export const specReadModelPlugin = {
  name: 'hyperfide-spec',
  pluginId: 'hyperfide-spec',
  autoInstall: true,
  defaultEnabled: true,
  register: registerSpecReadModel,
};
