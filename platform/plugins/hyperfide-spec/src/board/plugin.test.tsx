// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { installTestPluginRuntime, loadPluginApp, renderSlot } from '@hyperfide/plugin-sdk/testing/app';
import type { PluginNavPanelProps } from '@hyperfide/plugin-sdk/app';
import { featureFromKvx } from '../kvx.js';
import { mountBoard } from './app.js';
import type { boardContract } from './contract.js';
import type { Task } from './model.js';
import { BoardPanel } from './plugin-app.js';

installTestPluginRuntime();

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const tasks = featureFromKvx('demo', `[meta]
name = "Demo"
[req.R1]
ac_1 = "The board lists every task"
[task.1]
title = "Board fixture"
status = "pending"
wave = 2
owner = "app"
requires = []
touches = ["src/**"]
verify_cmd = "pnpm test"
reqs = ["R1.1"]
do_1 = "Render the board"
[task.2]
title = "Server fixture"
status = "pending"
wave = 3
owner = "server"
requires = ["1"]
touches = []
verify_cmd = ""
`).tasks;

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

interface BoardFixture {
  rows: Task[];
  detail: (task: Task) => Task;
  fail?: () => Error | null;
}

async function renderBoard(state: BoardFixture) {
  const app = await loadPluginApp(() => import('./plugin-app.js'));
  return renderSlot<PluginNavPanelProps, typeof boardContract>(app.navPanels[0]!, { subPath: '' }, {
    rpc: {
      boardTasks: () => {
        const failure = state.fail?.();
        if (failure) throw failure;
        return state.rows;
      },
      boardTask: ({ id }) => state.detail(state.rows.find(row => row.id === id)!),
      boardAction: ({ id, action }) => {
        state.rows = state.rows.map(row =>
          row.id === id ? { ...row, status: action === 'start' ? 'in_progress' : 'implemented' } : row,
        );
        return null;
      },
    },
  });
}

function setScope() {
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: '/repo' } });
  fireEvent.change(screen.getByLabelText('Feature'), { target: { value: 'demo' } });
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

test('registers Board in the platform navigation with the manifest icon', async () => {
  const app = await loadPluginApp(() => import('./plugin-app.js'));
  expect(app.navPanels).toHaveLength(1);
  expect(app.navPanels[0]).toMatchObject({ id: 'hyperfide-spec', title: 'Board', icon: 'ListTodo', path: 'hyperfide-spec' });
  expect(app.navPanels[0]!.component).toBe(BoardPanel);
});

test('mounted board selects real model tasks, filters and sends actions while done stays disabled', async () => {
  const root = document.createElement('div');
  document.body.append(root);
  const rpc = { tasks: vi.fn().mockResolvedValue(tasks), action: vi.fn().mockResolvedValue(undefined) };
  const dispose = mountBoard(root, { feature: 'demo', tasks }, rpc);
  root.querySelector<HTMLButtonElement>('[data-select="1"]')!.click();
  await vi.waitFor(() => expect(root.textContent).toContain('pnpm test'));
  expect([...root.querySelectorAll('button')].find(item => item.textContent === 'Done')?.disabled).toBe(true);
  root.querySelector<HTMLButtonElement>('[data-action="start"]')!.click();
  await vi.waitFor(() => expect(root.hasAttribute('aria-busy')).toBe(false));
  expect(rpc.action).toHaveBeenCalledWith('demo', '1', 'start');
  const owners = root.querySelector<HTMLSelectElement>('[data-filter="owner"]')!;
  owners.value = 'app';
  owners.dispatchEvent(new Event('change', { bubbles: true }));
  expect(root.querySelector('[data-select="1"]')).not.toBeNull();
  dispose();
  root.querySelector<HTMLButtonElement>('[data-select="1"]')!.click();
  expect(rpc.action).toHaveBeenCalledTimes(1);
});

test('Board panel loads the scoped feature by wave, opens a task and sends actions while done stays disabled', async () => {
  const slot = await renderBoard({
    rows: tasks,
    detail: task => ({
      ...task,
      latestReceipt: './receipts/1.md',
      recalledDecisions: [{ id: 7, created: 0, type: 'decision', task: '1', body: 'Keep the legacy renderer for hosts.' }],
      receipts: [{ digest: 'abc123', warnings: ['Verify command skipped'], log: './receipts/1.log', bundle: './receipts/1.bundle' }],
    }),
  });
  expect(screen.getByText('Enter a repository and a feature to load its board.')).toBeTruthy();
  expect(screen.queryByText('Host')).toBeNull();
  setScope();
  await screen.findByText('Board fixture');
  expect(slot.rpcCalls).toContainEqual({ method: 'boardTasks', input: { repository: '/repo', feature: 'demo' } });
  expect(screen.getByText('Wave 2')).toBeTruthy();
  expect(screen.getByText('Wave 3')).toBeTruthy();
  expect(screen.getByText('Waiting on 1')).toBeTruthy();
  expect(screen.getAllByText('Pending')).toHaveLength(2);

  fireEvent.click(button('Open task 1: Board fixture'));
  await screen.findByText('pnpm test');
  expect(slot.rpcCalls).toContainEqual({ method: 'boardTask', input: { repository: '/repo', feature: 'demo', id: '1' } });
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Board fixture');
  expect(screen.getByText('The board lists every task')).toBeTruthy();
  expect(screen.getByText('Render the board')).toBeTruthy();
  expect(screen.getByText('Keep the legacy renderer for hosts.')).toBeTruthy();
  expect(screen.getByText('Verify command skipped')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Latest receipt' }).getAttribute('href')).toBe('./receipts/1.md');
  expect(screen.getByRole('link', { name: 'Open log' }).getAttribute('href')).toBe('./receipts/1.log');
  expect(screen.getByText('Server fixture')).toBeTruthy();
  expect(button('Done').disabled).toBe(true);
  expect(button('Implemented').disabled).toBe(true);
  expect(button('Start').disabled).toBe(false);

  fireEvent.click(button('Start'));
  await waitFor(() =>
    expect(slot.rpcCalls).toContainEqual({
      method: 'boardAction',
      input: { repository: '/repo', feature: 'demo', id: '1', action: 'start' },
    }),
  );
  await screen.findByText('In progress');
  expect(button('Start').disabled).toBe(true);
  expect(button('Implemented').disabled).toBe(false);
  expect(button('Done').disabled).toBe(true);

  fireEvent.click(button('Board'));
  await screen.findByText('Server fixture');
  expect(button('Open task 1: Board fixture')).toBeTruthy();
});

test('Board panel filters tasks by owner and search', async () => {
  await renderBoard({ rows: tasks, detail: task => task });
  setScope();
  await screen.findByText('Board fixture');
  fireEvent.pointerDown(screen.getByRole('button', { name: /^Filters/ }));
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'server' }));
  await waitFor(() => expect(screen.queryByText('Board fixture')).toBeNull());
  expect(screen.getByText('Server fixture')).toBeTruthy();
  expect(screen.queryByText('Wave 2')).toBeNull();
  fireEvent.change(screen.getByPlaceholderText('Search tasks'), { target: { value: 'nothing' } });
  expect(screen.getByText('No tasks match "nothing" with these filters.')).toBeTruthy();
});

test('Board panel reports load failures and retries', async () => {
  let failures = 1;
  await renderBoard({
    rows: tasks,
    detail: task => task,
    fail: () => (failures-- > 0 ? new Error('Unknown repository') : null),
  });
  setScope();
  expect((await screen.findByRole('alert')).textContent).toContain('Board could not be loaded.');
  fireEvent.click(button('Retry'));
  await screen.findByText('Board fixture');
  expect(screen.queryByRole('alert')).toBeNull();
});
