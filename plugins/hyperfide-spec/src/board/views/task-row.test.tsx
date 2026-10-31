// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { installTestPluginRuntime } from '@hyperfide/plugin-sdk/testing/app';
import { CompactViewportOverrideProvider } from '@/components/ui/hooks/use-compact-viewport';
import { featureFromKvx } from '../../kvx.js';
import { TaskRow } from './task-row.js';

installTestPluginRuntime();

const tasks = featureFromKvx('demo', `[meta]
name = "Demo"
[task.1]
title = "Board fixture"
status = "pending"
wave = 2
owner = "app"
requires = []
touches = ["src/**"]
verify_cmd = ""
`).tasks;

afterEach(cleanup);

test('shows the task id beside the title on wide viewports', () => {
  const onOpen = vi.fn();
  render(<TaskRow task={tasks[0]!} tasks={tasks} onOpen={onOpen} />);
  const title = screen.getByRole('button', { name: 'Open task 1: Board fixture' });
  expect(title.textContent).toContain('1');
  expect(title.textContent).toContain('Pending');
  fireEvent.click(title);
  expect(onOpen).toHaveBeenCalledWith(tasks[0]);
});

test('moves the task id into the description on compact viewports', () => {
  render(
    <CompactViewportOverrideProvider isCompactViewport>
      <TaskRow task={tasks[0]!} tasks={tasks} onOpen={vi.fn()} />
    </CompactViewportOverrideProvider>,
  );
  const title = screen.getByRole('button', { name: 'Open task 1: Board fixture' });
  expect(title.textContent).toBe('Board fixturePending');
  const description = title.parentElement!.querySelector('span.block')!;
  expect(description.textContent).toContain('1');
  expect(description.textContent).toContain('app');
  expect(description.textContent).toContain('1 path');
});
