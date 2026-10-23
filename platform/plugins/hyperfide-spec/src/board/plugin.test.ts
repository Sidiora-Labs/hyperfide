// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { featureFromKvx } from '../kvx.js';
import { mountBoard } from './app.js';
import boardPlugin from './plugin-server.js';
import specPlugin from '../read-model-server.js';
import { boardContract } from './contract.js';
import { specContract } from '../shared/contract.js';
import type { HyperfidePluginApi } from '@hyperfide/plugin-sdk';
import type { PluginHosts, PluginRpc } from '@hyperfide/plugin-sdk';

const transport = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('@hyperfide/plugin-sdk/app', () => ({
  definePluginApp: (register: unknown) => register,
  useRpc: () => transport,
}));
import register, { BoardPanel } from './plugin-app.js';
const tasks = featureFromKvx('demo', `[meta]
name = "Demo"
[task.1]
title = "Board fixture"
status = "pending"
wave = 2
owner = "app"
requires = []
touches = ["src/**"]
verify_cmd = "pnpm test"
`).tasks;
afterEach(() => { document.body.innerHTML = ''; vi.clearAllMocks(); });

test('the manifest server composes read-model and board routes', async () => {
  const registerRpc = vi.fn();
  await specPlugin({
    storage: { kv: { get: async (key: string) => key === 'spec.repositories' ? [] : undefined } },
    hosts: { experimental_client: () => ({ call: vi.fn() }) },
    rpc: { register: registerRpc },
  } as unknown as HyperfidePluginApi);
  expect(registerRpc.mock.calls.map(call => call[0])).toEqual([boardContract, specContract]);
});

test('registers Board in the platform navigation and routes RPC to the selected host', async () => {
  const navPanel = vi.fn();
  (register as unknown as (app: unknown) => void)({ slots: { navPanel } });
  expect(navPanel).toHaveBeenCalledWith(expect.objectContaining({ title: 'Board', component: BoardPanel }));
  const call = vi.fn().mockResolvedValue(tasks);
  const registerRpc = vi.fn();
  boardPlugin({ hosts: { experimental_client: () => ({ call }) } as unknown as PluginHosts,
    rpc: { register: registerRpc } as unknown as PluginRpc });
  const handlers = registerRpc.mock.calls[0]![1];
  const scope = { hostId: 'host', repository: '/repo', feature: 'demo' };
  await handlers.boardTasks(scope);
  await handlers.boardAction({ ...scope, id: '1', action: 'start' });
  expect(call).toHaveBeenCalledWith('boardTasks', scope, { hostId: 'host' });
  expect(call).toHaveBeenLastCalledWith('boardAction', { ...scope, id: '1', action: 'start' }, { hostId: 'host' });
});

test('mounted board selects real model tasks, filters and sends actions while done stays disabled', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const rpc = { tasks: vi.fn().mockResolvedValue(tasks), action: vi.fn().mockResolvedValue(undefined) };
  const dispose = mountBoard(root, { feature: 'demo', tasks }, rpc);
  root.querySelector<HTMLButtonElement>('[data-select="1"]')!.click();
  expect(root.textContent).toContain('pnpm test');
  expect([...root.querySelectorAll('button')].find(button => button.textContent === 'Done')?.disabled).toBe(true);
  root.querySelector<HTMLButtonElement>('[data-action="start"]')!.click();
  await vi.waitFor(() => expect(root.hasAttribute('aria-busy')).toBe(false));
  expect(rpc.action).toHaveBeenCalledWith('demo', '1', 'start');
  const owners = root.querySelector<HTMLSelectElement>('[data-filter="owner"]')!;
  owners.value = 'app'; owners.dispatchEvent(new Event('change', { bubbles: true }));
  expect(root.querySelector('[data-select="1"]')).not.toBeNull();
  dispose();
  root.querySelector<HTMLButtonElement>('[data-select="1"]')!.click();
  expect(rpc.action).toHaveBeenCalledTimes(1);
});

test('platform Board component renders scope controls', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(BoardPanel)));
  expect(container.textContent).toContain('Host');
  expect(container.textContent).toContain('Repository');
  expect(container.textContent).toContain('Feature');
  await act(async () => root.unmount());
});
