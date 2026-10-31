import { expect, test, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardController, renderBoard, renderDetail, requiresSatisfied } from './app';
import { createBoardServer, latestReceipt } from './server';
import type { BoardAction, BoardModel, Task } from './model.js';

const task = (id: string, overrides: Partial<Task> = {}): Task => ({
  id, feature: 'hyperfide-v22', title: `Task ${id}`, status: 'pending', wave: 1, owner: 'spec', requires: [],
  touches: ['src/**'], verify_cmd: 'pnpm test', do: ['Build board'], reqs: ['3.2'],
  criteria: [{ id: '3.2', text: 'Show tasks by wave and status' }], ...overrides,
});
const model: BoardModel = { feature: 'hyperfide-v22', tasks: [
  task('1', { status: 'done', wave: 0 }),
  task('2', { requires: ['1'], status: 'in_progress', latestReceipt: '/receipts/latest' }),
  task('3', { requires: ['2'], owner: 'app', wave: 2 }),
  task('4', { requires: ['missing'], status: 'implemented' }),
] };

test('Board renders fixture waves, all status columns and owner/requires filters', () => {
  const html = renderBoard(model);
  for (const value of ['Wave 0', 'Wave 1', 'Wave 2', 'pending', 'in_progress', 'implemented', 'done']) expect(html).toContain(value);
  expect(renderBoard(model, { owner: 'app' })).toContain('data-select="3"');
  expect(renderBoard(model, { owner: 'app' })).not.toContain('data-select="2"');
  expect(renderBoard(model, { requiresSatisfied: true })).toContain('data-select="2"');
  expect(renderBoard(model, { requiresSatisfied: true })).not.toContain('data-select="3"');
  expect(renderBoard(model, { requiresSatisfied: false })).toContain('data-select="4"');
  expect(requiresSatisfied(model.tasks[3]!, model.tasks)).toBe(false);
});
test('detail renders criteria, touches, command, instructions, graph and receipt; done is disabled', () => {
  const html = renderDetail(model.tasks[1]!, model.tasks);
  for (const value of ['3.2: Show tasks', 'src/**', 'pnpm test', 'Build board', '1: done', '3: Task 3', 'href="/receipts/latest"']) expect(html).toContain(value);
  expect(html).toContain('<button disabled title="Qualification sets done">Done</button>');
  expect(html).not.toContain('data-action="done"');
  expect(renderDetail(model.tasks[2]!, model.tasks)).toContain('2: in_progress (blocks this task)');
  expect(renderDetail(model.tasks[0]!, model.tasks)).not.toContain('Latest receipt');
  const hostile = renderDetail(task('<script>', { latestReceipt: 'javascript:alert(1)' }), []);
  expect(hostile).not.toContain('<script>');
  expect(hostile).not.toContain('href=');
});
test('app sends actions through server, refreshes model, and exposes binary failures', async () => {
  const execute = vi.fn().mockResolvedValue(undefined);
  const read = vi.fn().mockResolvedValue(model.tasks);
  const rpc = createBoardServer('/repository', read, 'hyperfide', execute);
  const board = new BoardController(model, rpc);
  board.selected = '2';
  await board.action('2', 'implemented');
  expect(execute).toHaveBeenCalledWith('hyperfide', ['spec', 'implemented', '2', '-f', model.feature], '/repository');
  await board.action('3', 'start');
  expect(execute).toHaveBeenLastCalledWith('hyperfide', ['spec', 'start', '3', '-f', model.feature], '/repository');
  execute.mockRejectedValueOnce(new Error('requires 2 is not done'));
  await board.action('3', 'start');
  expect(board.render()).toContain('role="alert">requires 2 is not done');
  await board.action('2', 'done' as BoardAction);
  await expect(rpc.action(model.feature, '2', 'done' as BoardAction)).rejects.toThrow('Unsupported');
  expect(execute).toHaveBeenCalledTimes(3);
  await expect(rpc.action('../escape', '2', 'start')).rejects.toThrow('Invalid');
  await expect(rpc.action(model.feature, 'unknown', 'start')).rejects.toThrow('Unknown');
});
test('server executes a process without a shell and retains its failure message', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hyperfide-board-'));
  try {
    const binary = join(directory, 'hyperfide');
    await writeFile(binary, '#!/bin/sh\n[ "$1 $2 $3 $4 $5" = "spec start 2 -f hyperfide-v22" ] || exit 3\necho "requires 1 is not done" >&2\nexit 1\n', { mode: 0o755 });
    const rpc = createBoardServer(directory, async () => model.tasks, binary);
    await expect(rpc.action(model.feature, '2', 'start')).rejects.toThrow('requires 1 is not done');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('finds the latest real task receipt and omits the link when absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hyperfide-receipts-'));
  try {
    expect(await latestReceipt(directory, '2.2')).toBeUndefined();
    for (const [run, time] of [['older', 100], ['latest', 200]] as const) {
      const folder = join(directory, 'artifacts/hyperfide/tasks/2.2', run);
      await mkdir(folder, { recursive: true });
      const receipt = join(folder, 'receipt.json');
      await writeFile(receipt, '{}');
      await utimes(receipt, time, time);
    }
    expect(await latestReceipt(directory, '2.2')).toBe('./artifacts/hyperfide/tasks/2.2/latest/receipt.json');
    expect(await latestReceipt(directory, '..')).toBeUndefined();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
