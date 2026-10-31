// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { installTestPluginRuntime } from '@hyperfide/plugin-sdk/testing/app';
import { CompactViewportOverrideProvider } from '@/components/ui/hooks/use-compact-viewport';
import { featureFromKvx } from '../../kvx.js';
import { TaskDetail } from './task-detail.js';

installTestPluginRuntime();

const tasks = featureFromKvx('demo', `[meta]
name = "Demo"
[task.1]
title = "Board fixture"
status = "pending"
wave = 2
owner = "app"
requires = []
touches = []
verify_cmd = ""
`).tasks;

afterEach(cleanup);

const actionRow = () => document.querySelector('[data-task-actions]');

test('keeps the actions in the page header on wide viewports', () => {
  const onAction = vi.fn();
  render(<TaskDetail task={tasks[0]!} tasks={tasks} pending={false} onAction={onAction} />);
  expect(actionRow()).toBeNull();
  const heading = screen.getByRole('heading', { level: 1 });
  const start = screen.getByRole('button', { name: 'Start' });
  expect(heading.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(start);
  expect(onAction).toHaveBeenCalledWith('start');
});

test('moves the actions below the header on compact viewports without changing them', () => {
  const onAction = vi.fn();
  render(
    <CompactViewportOverrideProvider isCompactViewport>
      <TaskDetail task={tasks[0]!} tasks={tasks} pending={false} onAction={onAction} />
    </CompactViewportOverrideProvider>,
  );
  const row = actionRow();
  expect(row).not.toBeNull();
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Board fixture');
  const start = screen.getByRole('button', { name: 'Start' });
  expect(row!.contains(start)).toBe(true);
  expect(row!.contains(screen.getByRole('button', { name: 'Implemented' }))).toBe(true);
  expect(row!.contains(screen.getByRole('button', { name: 'Done' }))).toBe(true);
  expect(screen.getAllByRole('button', { name: 'Start' })).toHaveLength(1);
  expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(start);
  expect(onAction).toHaveBeenCalledWith('start');
});
