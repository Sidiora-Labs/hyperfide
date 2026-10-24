import type { IconName } from '@/components/ui/icon';
import type { ResourceStatusTone } from '@/components/ui/resource-list';
import type { Status } from '../../shared/model.js';
import type { Task } from '../model.js';
import { requiresSatisfied } from '../app.js';

export { requiresSatisfied };

export interface StatusPresentation {
  label: string;
  icon: IconName;
  tone: ResourceStatusTone;
  iconClassName: string;
}

export const STATUS_PRESENTATION: Record<Status, StatusPresentation> = {
  pending: { label: 'Pending', icon: 'Circle', tone: 'muted', iconClassName: 'text-muted-foreground' },
  in_progress: { label: 'In progress', icon: 'Play', tone: 'warning', iconClassName: 'text-warning' },
  blocked: { label: 'Blocked', icon: 'AlertCircle', tone: 'error', iconClassName: 'text-destructive' },
  implemented: { label: 'Implemented', icon: 'CircleCheck', tone: 'warning', iconClassName: 'text-warning' },
  done: { label: 'Done', icon: 'CircleCheck', tone: 'success', iconClassName: 'text-success' },
  superseded: { label: 'Superseded', icon: 'CircleX', tone: 'muted', iconClassName: 'text-muted-foreground' },
};

export function statusPresentation(status: Task['status']): StatusPresentation {
  return STATUS_PRESENTATION[status] ?? STATUS_PRESENTATION.pending;
}

export function isSafeReceiptLink(value: string | null | undefined): value is string {
  return typeof value === "string" && (/^https?:\/\//.test(value) || /^(?!\/\/)[/.]/.test(value));
}

export function taskSearchValues(task: Task): string[] {
  return [task.id, task.title, task.owner, task.status, ...task.touches, ...task.requires];
}

export function taskKey(task: Pick<Task, 'feature' | 'id'>): string {
  return `${task.feature}:${task.id}`;
}
