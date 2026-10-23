import { statuses, type BoardModel, type BoardRpc, type Task, type BoardAction } from './model.js';

const escape = (value: unknown) => String(value).replace(/[&<>"']/g,
  character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
const list = (values: string[]) => `<ul>${values.map(value => `<li>${escape(value)}</li>`).join('')}</ul>`;
export function requiresSatisfied(task: Task, tasks: Task[]): boolean {
  return task.requires.every(id => tasks.some(candidate => candidate.id === id && candidate.status === 'done'));
}
export interface Filters { owner?: string; requiresSatisfied?: boolean }
export function renderDetail(task: Task, tasks: Task[]): string {
  const blocks = tasks.filter(candidate => candidate.requires.includes(task.id));
  const receipt = task.latestReceipt;
  const safeReceipt = receipt && (/^https?:\/\//.test(receipt) || /^(?!\/\/)[/.]/.test(receipt));
  return `<section aria-label="Task detail"><h2>${escape(task.id)}: ${escape(task.title)}</h2>
<h3>Criteria</h3>${list(task.criteria.map(criterion => `${criterion.id}: ${criterion.text}`))}
<h3>Instructions</h3>${list(task.do)}<h3>Touches</h3>${list(task.touches)}
<h3>Verify command</h3><pre>${escape(task.verify_cmd)}</pre>
<h3>Requires</h3>${list(task.requires.map(id => {
    const dependency = tasks.find(candidate => candidate.id === id);
    return `${id}: ${dependency?.status ?? 'missing'}${dependency?.status === 'done' ? '' : ' (blocks this task)'}`;
  }))}<h3>Blocks</h3>${list(blocks.map(candidate => `${candidate.id}: ${candidate.title}`))}
${safeReceipt ? `<a href="${escape(receipt)}">Latest receipt</a>` : ''}
<button data-action="start" data-task="${escape(task.id)}"${task.status !== 'pending' ? ' disabled' : ''}>Start</button>
<button data-action="implemented" data-task="${escape(task.id)}"${task.status !== 'in_progress' ? ' disabled' : ''}>Implemented</button>
<button disabled title="Qualification sets done">Done</button></section>`;
}
export function renderBoard(model: BoardModel, filters: Filters = {}, selected?: string): string {
  const tasks = model.tasks.filter(task => (!filters.owner || task.owner === filters.owner)
    && (filters.requiresSatisfied === undefined || requiresSatisfied(task, model.tasks) === filters.requiresSatisfied));
  const owners = [...new Set(model.tasks.map(task => task.owner))].sort();
  return `<main aria-label="Board"><h1>${escape(model.feature)} / Board</h1>
<label>Owner<select data-filter="owner"><option value="">All owners</option>${owners.map(owner => `<option value="${escape(owner)}"${owner === filters.owner ? ' selected' : ''}>${escape(owner)}</option>`).join('')}</select></label>
<label>Requires satisfied<select data-filter="requires"><option value="">All tasks</option><option value="true"${filters.requiresSatisfied === true ? ' selected' : ''}>Yes</option><option value="false"${filters.requiresSatisfied === false ? ' selected' : ''}>No</option></select></label>
${[...new Set(tasks.map(task => task.wave))].sort((a, b) => a - b).map(wave => `<section aria-label="Wave ${wave}"><h2>Wave ${wave}</h2>${statuses.map(status => `<section aria-label="${status}"><h3>${status}</h3>${tasks.filter(task => task.wave === wave && task.status === status).map(task => `<button data-select="${escape(task.id)}">${escape(task.id)}: ${escape(task.title)}</button>`).join('')}</section>`).join('')}</section>`).join('')}
${selected && model.tasks.some(task => task.id === selected) ? renderDetail(model.tasks.find(task => task.id === selected)!, model.tasks) : ''}</main>`;
}
export class BoardController {
  filters: Filters = {};
  selected?: string;
  error = '';
  busy = false;
  constructor(public model: BoardModel, private rpc: BoardRpc) {}
  render() { return `${renderBoard(this.model, this.filters, this.selected)}<p role="alert">${escape(this.error)}</p>`; }
  async action(id: string, action: BoardAction) {
    if (this.busy) return;
    if (action !== 'start' && action !== 'implemented') { this.error = 'Unsupported board action'; return; }
    this.busy = true;
    this.error = '';
    try {
      await this.rpc.action(this.model.feature, id, action);
      this.model = { ...this.model, tasks: await this.rpc.tasks(this.model.feature) };
    } catch (error) { this.error = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; }
  }
}

export function mountBoard(root: HTMLElement, model: BoardModel, rpc: BoardRpc): () => void {
  const board = new BoardController(model, rpc);
  let disposed = false;
  const render = () => { if (!disposed) root.innerHTML = board.render(); };
  const click = async (event: Event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button');
    if (!button || button.disabled || board.busy) return;
    if (button.dataset.select) { board.selected = button.dataset.select; render(); }
    if (button.dataset.action && button.dataset.task) {
      const pending = board.action(button.dataset.task, button.dataset.action as BoardAction);
      root.setAttribute('aria-busy', 'true');
      await pending;
      root.removeAttribute('aria-busy');
      render();
    }
  };
  const change = (event: Event) => {
    const select = event.target as HTMLSelectElement;
    if (select.dataset.filter === 'owner') board.filters.owner = select.value || undefined;
    if (select.dataset.filter === 'requires') board.filters.requiresSatisfied = select.value ? select.value === 'true' : undefined;
    render();
  };
  root.addEventListener('click', click);
  root.addEventListener('change', change);
  render();
  return () => { disposed = true; root.removeEventListener('click', click); root.removeEventListener('change', change); };
}
