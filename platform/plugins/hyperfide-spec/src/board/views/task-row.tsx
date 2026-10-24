import { useIsCompactViewport } from '@/components/ui/hooks/use-compact-viewport';
import { Icon } from '@/components/ui/icon';
import { Pill } from '@/components/ui/pill';
import { ResourceMeta, ResourceRow } from '@/components/ui/resource-list';
import { cn } from '@/lib/utils';
import type { Task } from '../model.js';
import { requiresSatisfied, statusPresentation } from './task-presentation.js';

export function TaskStatusIcon({ status, className }: { status: Task['status']; className?: string }) {
  const presentation = statusPresentation(status);
  return (
    <Icon
      name={presentation.icon}
      className={cn('size-4 shrink-0', presentation.iconClassName, className)}
      aria-hidden
    />
  );
}

export function TaskStatusPill({ status }: { status: Task['status'] }) {
  const presentation = statusPresentation(status);
  return (
    <Pill
      variant={status === 'done' ? 'secondary' : status === 'blocked' ? 'destructive' : 'outline'}
      size="sm"
      className="shrink-0 self-center"
    >
      {presentation.label}
    </Pill>
  );
}

export function requirementsSummary(task: Task, tasks: Task[]): string {
  if (task.requires.length === 0) return 'No requirements';
  const satisfied = requiresSatisfied(task, tasks);
  return `${satisfied ? 'Requires' : 'Waiting on'} ${task.requires.join(', ')}`;
}

export function TaskRow({ task, tasks, onOpen }: { task: Task; tasks: Task[]; onOpen: (task: Task) => void }) {
  const compact = useIsCompactViewport();
  const touches = task.touches.length;
  return (
    <ResourceRow
      leading={<TaskStatusIcon status={task.status} />}
      title={task.title}
      titleMeta={compact ? undefined : task.id}
      state={<TaskStatusPill status={task.status} />}
      description={
        <ResourceMeta
          items={[
            compact ? task.id : null,
            task.owner,
            requirementsSummary(task, tasks),
            touches > 0 ? `${touches} ${touches === 1 ? 'path' : 'paths'}` : null,
          ]}
        />
      }
      trailingVisual={<Icon name="ChevronRight" className="size-4 text-subtle-foreground" aria-hidden />}
      openLabel={`Open task ${task.id}: ${task.title}`}
      onOpen={() => onOpen(task)}
    />
  );
}
