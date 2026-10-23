import { createElement, useEffect, useRef, useState } from 'react';
import { definePluginApp, useRpc } from '@hyperfide/plugin-sdk/app';
import { boardContract } from './contract.js';
import { mountBoard } from './app.js';

export function BoardPanel() {
  const rpc = useRpc<typeof boardContract>();
  const root = useRef<HTMLDivElement>(null);
  const [hostId, setHost] = useState('');
  const [repository, setRepository] = useState('');
  const [feature, setFeature] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let dispose: (() => void) | undefined;
    setError('');
    if (root.current) root.current.innerHTML = '';
    if (hostId && repository && feature) {
      const scope = { hostId, repository, feature };
      void rpc.call('boardTasks', scope).then(tasks => {
        if (active && root.current) dispose = mountBoard(root.current, { feature, tasks }, {
          tasks: feature => rpc.call('boardTasks', { ...scope, feature }),
          task: (feature, id) => rpc.call('boardTask', { ...scope, feature, id }),
          action: (feature, id, action) => rpc.call('boardAction', { ...scope, feature, id, action }),
        });
      }).catch(error => { if (active) setError(String(error)); });
    }
    return () => { active = false; dispose?.(); };
  }, [rpc, hostId, repository, feature]);
  const field = (label: string, value: string, set: (value: string) => void) =>
    createElement('label', null, label, createElement('input', {
      value, onChange: (event: React.ChangeEvent<HTMLInputElement>) => set(event.target.value),
    }));
  return createElement('section', null,
    field('Host', hostId, setHost), field('Repository', repository, setRepository), field('Feature', feature, setFeature),
    createElement('p', { role: 'alert' }, error), createElement('div', { ref: root }));
}
export default definePluginApp(app => {
  app.slots.navPanel({ id: 'hyperfide-spec', title: 'Board', icon: 'List', path: 'hyperfide-spec', component: BoardPanel });
});
