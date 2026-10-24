import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useHyperfideNavigate, useRpc, type PluginNavPanelProps } from '@hyperfide/plugin-sdk/app';
import { DelayedLoading } from '@/components/ui/delayed-loading';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  ResourceCollectionPage,
  ResourceCollectionViewport,
  ResourceDefinitionSection,
  ResourceDetailPanel,
  ResourceFilterMenu,
  ResourceListPanel,
  ResourceListState,
  ResourceToolbar,
} from '@/components/ui/resource-list';
import { boardContract } from '../contract.js';
import { statuses, type BoardAction, type Task } from '../model.js';
import { PANEL_PATH, parseBoardSubPath, taskSubPath } from './board-route.js';
import { requiresSatisfied, statusPresentation, taskSearchValues } from './task-presentation.js';
import { TaskDetail } from './task-detail.js';
import { TaskRow } from './task-row.js';

const ERROR_CLASS =
  'rounded-md border border-surface-destructive-border bg-surface-destructive px-2 py-1 text-xs text-destructive-text';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PanelFrame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border h-full min-h-full w-full max-w-5xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        {children}
      </div>
    </div>
  );
}

function ScopeFields({
  repository,
  feature,
  onRepositoryChange,
  onFeatureChange,
}: {
  repository: string;
  feature: string;
  onRepositoryChange: (value: string) => void;
  onFeatureChange: (value: string) => void;
}) {
  const formId = useId();
  const repositoryId = `${formId}-repository`;
  const featureId = `${formId}-feature`;
  return (
    <ResourceDetailPanel surface="recessed" className="px-3 py-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={repositoryId}>Repository</Label>
          <Input
            id={repositoryId}
            value={repository}
            autoComplete="off"
            spellCheck={false}
            placeholder="/path/to/repository"
            className="bg-background font-mono"
            onChange={event => onRepositoryChange(event.target.value)}
          />
        </div>
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={featureId}>Feature</Label>
          <Input
            id={featureId}
            value={feature}
            autoComplete="off"
            spellCheck={false}
            placeholder="hyperfide-v22"
            className="bg-background"
            onChange={event => onFeatureChange(event.target.value)}
          />
        </div>
      </div>
    </ResourceDetailPanel>
  );
}

const STATUS_ORDER = new Map(statuses.map((status, index) => [status, index]));

export function BoardPanel({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof boardContract>();
  const navigate = useHyperfideNavigate();
  const routeTaskId = parseBoardSubPath(subPath)?.taskId ?? null;
  const [repository, setRepository] = useState('');
  const [feature, setFeature] = useState('');
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState('');
  const [generation, setGeneration] = useState(0);
  const detailLoaded = useRef(new Set<string>());
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState('');
  const [ownerFilters, setOwnerFilters] = useState<string[]>([]);
  const [statusFilters, setStatusFilters] = useState<string[]>([]);
  const [requirementFilters, setRequirementFilters] = useState<string[]>([]);
  const scopeReady = repository.trim() !== '' && feature.trim() !== '';

  const changeScope = useCallback((next: { repository?: string; feature?: string }) => {
    if (next.repository !== undefined) setRepository(next.repository);
    if (next.feature !== undefined) setFeature(next.feature);
    setTasks(null);
    setError('');
    detailLoaded.current.clear();
  }, []);

  useEffect(() => {
    if (!scopeReady) return;
    let active = true;
    void rpc
      .call('boardTasks', { repository, feature })
      .then(rows => {
        if (active) setTasks(rows);
      })
      .catch((cause: unknown) => {
        if (active) setError(errorText(cause));
      });
    return () => {
      active = false;
    };
  }, [rpc, repository, feature, scopeReady, generation]);

  const retry = useCallback(() => {
    setTasks(null);
    setError('');
    detailLoaded.current.clear();
    setGeneration(current => current + 1);
  }, []);

  const loadDetail = useCallback(
    (id: string) =>
      rpc
        .call('boardTask', { repository, feature, id })
        .then(detail => {
          setTasks(rows => (rows === null ? rows : rows.map(row => (row.id === id ? detail : row))));
        })
        .catch((cause: unknown) => {
          setError(errorText(cause));
        }),
    [rpc, repository, feature],
  );

  useEffect(() => {
    if (routeTaskId === null || tasks === null || detailLoaded.current.has(routeTaskId)) return;
    if (!tasks.some(task => task.id === routeTaskId)) return;
    detailLoaded.current.add(routeTaskId);
    void loadDetail(routeTaskId);
  }, [routeTaskId, tasks, loadDetail]);

  const open = useCallback(
    (task: Task) => {
      navigate.toPluginPanel(PANEL_PATH, { subPath: taskSubPath(task.id) });
    },
    [navigate],
  );

  const act = useCallback(
    async (id: string, action: BoardAction) => {
      if (pending) return;
      setPending(true);
      setError('');
      try {
        await rpc.call('boardAction', { repository, feature, id, action });
        const rows = await rpc.call('boardTasks', { repository, feature });
        const detail = await rpc.call('boardTask', { repository, feature, id }).catch(() => null);
        detailLoaded.current.add(id);
        setTasks(detail ? rows.map(row => (row.id === id ? detail : row)) : rows);
      } catch (cause: unknown) {
        setError(errorText(cause));
      } finally {
        setPending(false);
      }
    },
    [rpc, repository, feature, pending],
  );

  const allTasks = useMemo(() => tasks ?? [], [tasks]);
  const owners = useMemo(() => [...new Set(allTasks.map(task => task.owner))].sort(), [allTasks]);
  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      allTasks.filter(
        task =>
          (ownerFilters.length === 0 || ownerFilters.includes(task.owner)) &&
          (statusFilters.length === 0 || statusFilters.includes(task.status)) &&
          (requirementFilters.length === 0 ||
            requirementFilters.length === 2 ||
            requirementFilters.includes(requiresSatisfied(task, allTasks) ? 'satisfied' : 'waiting')) &&
          (normalizedQuery === '' ||
            taskSearchValues(task).some(value => value.toLowerCase().includes(normalizedQuery))),
      ),
    [allTasks, ownerFilters, statusFilters, requirementFilters, normalizedQuery],
  );
  const waves = useMemo(() => {
    const grouped = new Map<number, Task[]>();
    for (const task of visible) grouped.set(task.wave, [...(grouped.get(task.wave) ?? []), task]);
    return [...grouped.entries()]
      .sort(([a], [b]) => a - b)
      .map(([wave, rows]) => ({
        wave,
        tasks: [...rows].sort(
          (a, b) =>
            (STATUS_ORDER.get(a.status) ?? 0) - (STATUS_ORDER.get(b.status) ?? 0) ||
            a.id.localeCompare(b.id, undefined, { numeric: true }),
        ),
      }));
  }, [visible]);
  const selected = routeTaskId === null ? null : (allTasks.find(task => task.id === routeTaskId) ?? null);
  const missingRouteTask = routeTaskId !== null && tasks !== null && selected === null;
  const hasFilters = ownerFilters.length > 0 || statusFilters.length > 0 || requirementFilters.length > 0;

  let body: ReactNode;
  if (!scopeReady) {
    body = <ResourceListState state="empty" message="Enter a repository and a feature to load its board." />;
  } else if (tasks === null && error) {
    body = <ResourceListState state="error" message="Board could not be loaded." onRetry={retry} />;
  } else if (tasks === null) {
    body = (
      <DelayedLoading>
        <ResourceListState state="loading" message="Loading tasks" />
      </DelayedLoading>
    );
  } else if (tasks.length === 0) {
    body = <ResourceListState state="empty" message={`No tasks in ${feature}.`} />;
  } else if (visible.length === 0) {
    body = (
      <ResourceListState
        state="empty"
        message={
          normalizedQuery === ''
            ? 'No tasks match these filters.'
            : hasFilters
              ? `No tasks match "${query}" with these filters.`
              : `No tasks match "${query}"`
        }
      />
    );
  } else {
    body = waves.map(group => (
      <ResourceDefinitionSection
        key={group.wave}
        label={`Wave ${group.wave}`}
        actions={
          <span className="text-xs text-muted-foreground">
            {group.tasks.length} {group.tasks.length === 1 ? 'task' : 'tasks'}
          </span>
        }
      >
        <ResourceListPanel>
          {group.tasks.map(task => (
            <TaskRow key={task.id} task={task} tasks={allTasks} onOpen={open} />
          ))}
        </ResourceListPanel>
      </ResourceDefinitionSection>
    ));
  }

  if (selected) {
    return (
      <PanelFrame>
        <div className="space-y-4">
          {error ? (
            <p role="alert" className={ERROR_CLASS}>
              {error}
            </p>
          ) : null}
          <TaskDetail
            task={selected}
            tasks={allTasks}
            pending={pending}
            onAction={action => void act(selected.id, action)}
          />
        </div>
      </PanelFrame>
    );
  }

  return (
    <PanelFrame>
      <ResourceCollectionPage
        id="hyperfide-spec-board"
        description="Tasks of a feature spec grouped by wave. Start a task to claim it, mark it implemented when its criteria hold; qualification alone sets done."
      >
        <ResourceCollectionViewport
          scrollId="hyperfide-spec-board-results"
          contentClassName="space-y-6"
          toolbar={
            <ResourceToolbar
              searchValue={query}
              searchPlaceholder="Search tasks"
              onSearchChange={setQuery}
              controls={
                <ResourceFilterMenu
                  compact
                  groups={[
                    {
                      id: 'owner',
                      label: 'Owner',
                      options: owners.map(owner => ({ id: owner, label: owner })),
                      selectedValues: ownerFilters,
                      onChange: setOwnerFilters,
                    },
                    {
                      id: 'status',
                      label: 'Status',
                      options: statuses.map(status => ({ id: status, label: statusPresentation(status).label })),
                      selectedValues: statusFilters,
                      onChange: setStatusFilters,
                    },
                    {
                      id: 'requirements',
                      label: 'Requirements',
                      options: [
                        { id: 'satisfied', label: 'Requires satisfied', description: 'Every required task is done' },
                        { id: 'waiting', label: 'Waiting on requirements', description: 'A required task is not done or is missing' },
                      ],
                      selectedValues: requirementFilters,
                      onChange: setRequirementFilters,
                    },
                  ]}
                />
              }
            />
          }
        >
          <ScopeFields
            repository={repository}
            feature={feature}
            onRepositoryChange={value => changeScope({ repository: value })}
            onFeatureChange={value => changeScope({ feature: value })}
          />
          {missingRouteTask ? (
            <p role="alert" className={ERROR_CLASS}>
              Task {routeTaskId} is not on this board.
            </p>
          ) : null}
          {error && tasks !== null ? (
            <p role="alert" className={ERROR_CLASS}>
              {error}
            </p>
          ) : null}
          {body}
        </ResourceCollectionViewport>
      </ResourceCollectionPage>
    </PanelFrame>
  );
}
