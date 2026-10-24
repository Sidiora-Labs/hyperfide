import { readFile } from 'node:fs/promises';
import { expect, test, vi } from 'vitest';
import type { HyperfidePluginApi, PluginRpc } from '@hyperfide/plugin-sdk';
import { featureFromKvx } from '../kvx.js';
import { specContract } from '../shared/contract.js';
import specPlugin from '../read-model-server.js';
import { boardContract } from './contract.js';
import boardPlugin, { registerBoardHandlers } from './plugin-server.js';

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

test('the manifest server composes read-model and board routes', async () => {
  const registerRpc = vi.fn();
  await specPlugin({
    storage: { kv: { get: async (key: string) => (key === 'spec.repositories' ? [] : undefined) } },
    rpc: { register: registerRpc },
  } as unknown as HyperfidePluginApi);
  expect(registerRpc.mock.calls.map(call => call[0])).toEqual([boardContract, specContract]);
});

test('routes board RPC to the scoped server', async () => {
  const board = {
    tasks: vi.fn().mockResolvedValue(tasks),
    task: vi.fn().mockResolvedValue(tasks[0]),
    action: vi.fn().mockResolvedValue(undefined),
  };
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

test('server rejects repositories outside its configured sources', async () => {
  const registerRpc = vi.fn();
  boardPlugin({ rpc: { register: registerRpc } as unknown as PluginRpc }, ['/allowed']);
  await expect(registerRpc.mock.calls[0]![1].boardTasks({ repository: '/other', feature: 'demo' })).rejects.toThrow(
    'Unknown repository',
  );
});

test('the board uses the platform server without a host bundle', async () => {
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  expect(manifest.hyperfide.server).toBe('./src/read-model-server.ts');
  expect(manifest.hyperfide.app).toBe('./src/board/plugin-app.ts');
  expect(manifest.hyperfide.branding.icon).toBe('ListTodo');
  expect(manifest.hyperfide).not.toHaveProperty('host');
});
