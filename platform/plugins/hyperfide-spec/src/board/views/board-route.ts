import type { ExperimentalPageTitle, PluginNavPanelProps } from '@hyperfide/plugin-sdk/app';

export const PANEL_PATH = 'hyperfide-spec';
export const BOARD_ROUTE = `/plugins/${PANEL_PATH}/${PANEL_PATH}`;

export interface BoardRoute {
  taskId: string;
}

export function parseBoardSubPath(subPath: string): BoardRoute | null {
  const parts = subPath.split('/').filter(part => part.length > 0);
  if (parts.length !== 2 || parts[0] !== 'task') return null;
  try {
    return { taskId: decodeURIComponent(parts[1]!) };
  } catch {
    return null;
  }
}

export function taskSubPath(id: string): string {
  return `task/${encodeURIComponent(id)}`;
}

export function useBoardPageTitle({ subPath }: PluginNavPanelProps): ExperimentalPageTitle | null {
  const route = parseBoardSubPath(subPath);
  return route ? { breadcrumbs: [{ label: 'Tasks', to: BOARD_ROUTE }, { label: route.taskId }] } : null;
}
