import { definePluginApp } from '@hyperfide/plugin-sdk/app';
import { BoardPanel } from './views/board-panel.js';
import { PANEL_PATH, useBoardPageTitle } from './views/board-route.js';

export { BoardPanel } from './views/board-panel.js';
export { useBoardPageTitle } from './views/board-route.js';

export default definePluginApp(app => {
  app.slots.navPanel({
    id: 'hyperfide-spec',
    title: 'Board',
    icon: 'ListTodo',
    path: PANEL_PATH,
    component: BoardPanel,
    experimental_usePageTitle: useBoardPageTitle,
  });
});
