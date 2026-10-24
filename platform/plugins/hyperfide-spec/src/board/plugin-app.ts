import { definePluginApp } from '@hyperfide/plugin-sdk/app';
import { BoardPanel } from './views/board-panel.js';

export { BoardPanel } from './views/board-panel.js';

export default definePluginApp(app => {
  app.slots.navPanel({ id: 'hyperfide-spec', title: 'Board', icon: 'ListTodo', path: 'hyperfide-spec', component: BoardPanel });
});
