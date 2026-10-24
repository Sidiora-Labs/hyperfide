import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import {
  ResourceActivitySection,
  ResourceDefinitionSection,
  ResourceDetailCollection,
  ResourceDetailPage,
  ResourceDetailStack,
  ResourceMeta,
  ResourceStatus,
} from '@/components/ui/resource-list';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { BoardAction, Task } from '../model.js';
import { isSafeReceiptLink, statusPresentation } from './task-presentation.js';
import { TaskStatusIcon, TaskStatusPill } from './task-row.js';

const CODE_CLASS =
  'whitespace-pre-wrap break-words rounded-md bg-surface-recessed/70 px-3 py-2 font-mono text-xs leading-relaxed text-foreground';

function Rows({ items, empty = 'None.' }: { items: ReactNode[]; empty?: string }) {
  if (items.length === 0) return <p className="text-xs text-muted-foreground">{empty}</p>;
  return (
    <ResourceDetailCollection>
      {items.map((item, index) => (
        <div key={index} className="flex min-w-0 items-start gap-3 px-3 py-2 text-sm">
          {item}
        </div>
      ))}
    </ResourceDetailCollection>
  );
}

function Keyed({ id, children, mono = false }: { id: string; children: ReactNode; mono?: boolean }) {
  return (
    <>
      <span className="shrink-0 font-mono text-xs leading-5 text-muted-foreground">{id}</span>
      <span className={mono ? 'min-w-0 break-all font-mono text-xs leading-5' : 'min-w-0 break-words'}>{children}</span>
    </>
  );
}

function ReceiptLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-xs text-foreground underline-offset-2 hover:underline"
    >
      <Icon name="ExternalLink" className="size-3.5" aria-hidden />
      {children}
    </a>
  );
}

export function TaskDetail({
  task,
  tasks,
  pending,
  onAction,
}: {
  task: Task;
  tasks: Task[];
  pending: boolean;
  onAction: (action: BoardAction) => void;
}) {
  const blocks = tasks.filter(candidate => candidate.requires.includes(task.id));
  const presentation = statusPresentation(task.status);
  const receipts = task.receipts ?? [];
  const decisions = task.recalledDecisions ?? [];
  return (
    <div className="space-y-4" aria-busy={pending || undefined}>
      <ResourceDetailPage
        leading={<TaskStatusIcon status={task.status} />}
        title={task.title}
        titleMeta={task.id}
        metadata={
          <ResourceMeta
            items={[
              <TaskStatusPill status={task.status} />,
              task.owner,
              `Wave ${task.wave}`,
              task.feature,
            ]}
          />
        }
        actions={
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending || task.status !== 'pending'}
              onClick={() => onAction('start')}
            >
              Start
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending || task.status !== 'in_progress'}
              onClick={() => onAction('implemented')}
            >
              Implemented
            </Button>
            <TooltipProvider delayDuration={250}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex cursor-not-allowed" tabIndex={0}>
                    <Button type="button" size="sm" variant="outline" disabled>
                      Done
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">Qualification sets done</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </>
        }
      >
        <ResourceDetailStack>
          <ResourceDefinitionSection label="Criteria">
            <Rows
              items={task.criteria.map(criterion => (
                <Keyed id={criterion.id}>{criterion.text}</Keyed>
              ))}
            />
          </ResourceDefinitionSection>
          <ResourceDefinitionSection label="Instructions">
            <Rows
              items={task.do.map((step, index) => (
                <Keyed id={String(index + 1)}>{step}</Keyed>
              ))}
            />
          </ResourceDefinitionSection>
          <ResourceDefinitionSection label="Touches">
            <Rows
              items={task.touches.map(path => (
                <span className="min-w-0 break-all font-mono text-xs leading-5">{path}</span>
              ))}
            />
          </ResourceDefinitionSection>
          <ResourceDefinitionSection label="Verify command">
            {task.verify_cmd ? <pre className={CODE_CLASS}>{task.verify_cmd}</pre> : <p className="text-xs text-muted-foreground">None.</p>}
          </ResourceDefinitionSection>
          <ResourceDefinitionSection
            label="Requires"
            actions={
              <ResourceStatus tone={task.requires.length === 0 ? 'muted' : presentation.tone === 'success' ? 'success' : 'muted'}>
                {task.requires.length === 0 ? 'No requirements' : `${task.requires.length} required`}
              </ResourceStatus>
            }
          >
            <Rows
              items={task.requires.map(id => {
                const dependency = tasks.find(candidate => candidate.id === id);
                const done = dependency?.status === 'done';
                return (
                  <>
                    <span className="shrink-0 font-mono text-xs leading-5 text-muted-foreground">{id}</span>
                    <span className="min-w-0 flex-1 truncate">{dependency?.title ?? 'Missing task'}</span>
                    <ResourceStatus tone={done ? 'success' : dependency ? 'warning' : 'error'}>
                      {dependency ? statusPresentation(dependency.status).label : 'missing'}
                      {done ? '' : ' · blocks this task'}
                    </ResourceStatus>
                  </>
                );
              })}
            />
          </ResourceDefinitionSection>
          <ResourceDefinitionSection label="Blocks">
            <Rows
              empty="Nothing waits on this task."
              items={blocks.map(candidate => (
                <>
                  <span className="shrink-0 font-mono text-xs leading-5 text-muted-foreground">{candidate.id}</span>
                  <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                  <TaskStatusPill status={candidate.status} />
                </>
              ))}
            />
          </ResourceDefinitionSection>
          {decisions.length > 0 ? (
            <ResourceDefinitionSection label="Recalled decisions">
              <Rows
                items={decisions.map(memory => (
                  <Keyed id={`#${memory.id}`}>
                    <span className="mr-1.5 text-xs text-muted-foreground">[{memory.type}]</span>
                    {memory.body}
                  </Keyed>
                ))}
              />
            </ResourceDefinitionSection>
          ) : null}
          {receipts.length > 0 || isSafeReceiptLink(task.latestReceipt) ? (
            <ResourceActivitySection
              label="Receipts"
              actions={isSafeReceiptLink(task.latestReceipt) ? <ReceiptLink href={task.latestReceipt}>Latest receipt</ReceiptLink> : null}
            >
              {receipts.length === 0 ? (
                <p className="text-xs text-muted-foreground">No receipt details recorded.</p>
              ) : (
                <ResourceDetailCollection>
                  {receipts.map(receipt => (
                    <article key={receipt.digest} aria-label="Receipt" className="space-y-2 px-3 py-2">
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <code className="min-w-0 truncate font-mono text-xs text-foreground">{receipt.digest}</code>
                        <span className="flex shrink-0 items-center gap-3">
                          <ReceiptLink href={receipt.log}>Open log</ReceiptLink>
                          <ReceiptLink href={receipt.bundle}>Open bundle list</ReceiptLink>
                        </span>
                      </div>
                      {receipt.warnings.length > 0 ? (
                        <ul className="space-y-1">
                          {receipt.warnings.map((warning, index) => (
                            <li key={index} className="flex items-start gap-1.5 text-xs text-warning">
                              <Icon name="AlertTriangle" className="mt-px size-3.5 shrink-0" aria-hidden />
                              <span className="min-w-0 break-words">{warning}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted-foreground">No warnings.</p>
                      )}
                    </article>
                  ))}
                </ResourceDetailCollection>
              )}
            </ResourceActivitySection>
          ) : null}
        </ResourceDetailStack>
      </ResourceDetailPage>
    </div>
  );
}
