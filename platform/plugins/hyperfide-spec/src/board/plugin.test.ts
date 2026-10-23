// @vitest-environment jsdom
import { createElement, act } from 'react';
import { readFile } from 'node:fs/promises';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { featureFromKvx } from '../kvx.js';
import { mountBoard } from './app.js';
import boardPlugin, { registerBoardHandlers } from './plugin-server.js';
import specPlugin from '../read-model-server.js';
import { boardContract } from './contract.js';
import { specContract } from '../shared/contract.js';
import type { HyperfidePluginApi } from '@hyperfide/plugin-sdk';
import type { PluginRpc } from '@hyperfide/plugin-sdk';

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
    rpc: { register: registerRpc },
  } as unknown as HyperfidePluginApi);
  expect(registerRpc.mock.calls.map(call => call[0])).toEqual([boardContract, specContract]);
});

test('registers Board in the platform navigation and routes RPC to the server', async () => {
  const navPanel = vi.fn();
  (register as unknown as (app: unknown) => void)({ slots: { navPanel } });
  expect(navPanel).toHaveBeenCalledWith(expect.objectContaining({ title: 'Board', component: BoardPanel }));
  const board = { tasks: vi.fn().mockResolvedValue(tasks), task: vi.fn().mockResolvedValue(tasks[0]), action: vi.fn().mockResolvedValue(undefined) };
  const registerRpc = vi.fn();
  registerBoardHandlers({ rpc: { register: registerRpc } as unknown as PluginRpc }, async (_repository, use) => use(board));
  const handlers = registerRpc.mock.calls[0]![1];
  const scope = { repository: '/repo', feature: 'demo' };
  expect(await handlers.boardTasks(scope)).toEqual(tasks);
  expect(await handlers.boardTask({ ...scope, id: '1' })).toEqual(tasks[0]);
  await handlers.boardAction({ ...scope, id: '1', action: 'start' });
  expect(board.tasks).toHaveBeenCalledWith('demo');
  expect(board.task).toHaveBeenCalledWith('demo', '1');
  expect(board.action).toHaveBeenCalledWith('demo', '1', 'start');

});

test('mounted board selects real model tasks, filters and sends actions while done stays disabled', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const rpc = { tasks: vi.fn().mockResolvedValue(tasks), action: vi.fn().mockResolvedValue(undefined) };
  const dispose = mountBoard(root, { feature: 'demo', tasks }, rpc);
  root.querySelector<HTMLButtonElement>('[data-select="1"]')!.click();
  await vi.waitFor(() => expect(root.textContent).toContain('pnpm test'));
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
  expect(container.textContent).not.toContain('Host');
  expect(container.textContent).toContain('Repository');
  expect(container.textContent).toContain('Feature');
  await act(async () => root.unmount());
});

test('server rejects repositories outside its configured sources', async () => {
  const registerRpc = vi.fn();
  boardPlugin({ rpc: { register: registerRpc } as unknown as PluginRpc }, ['/allowed']);
  await expect(registerRpc.mock.calls[0]![1].boardTasks({ repository: '/other', feature: 'demo' })).rejects.toThrow('Unknown repository');
});

test('the board uses the platform server without a host bundle', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  expect(manifest.hyperfide.server).toBe('./src/read-model-server.ts');
  expect(manifest.hyperfide.app).toBe('./src/board/plugin-app.ts');
  expect(manifest.hyperfide).not.toHaveProperty('host');
});
