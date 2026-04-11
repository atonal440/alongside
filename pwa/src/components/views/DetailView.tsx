import { marked } from 'marked';
import { useAppState } from '../../hooks/useAppState';
import { completeTaskAction, focusTaskAction } from '../../context/actions';
import { pushNav } from '../../hooks/useHistory';
import type { Task } from '../../types';

function Markdown({ src }: { src: string }) {
  const html = marked(src, { breaks: true }) as string;
  return <div className="detail-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function DetailView() {
  const { state, dispatch } = useAppState();
  const config = { apiBase: state.apiBase, authToken: state.authToken };
  const today = new Date().toISOString().split('T')[0];

  const taskOrUndef = state.tasks.find(t => t.id === state.detailTaskId);
  if (!taskOrUndef) return null;
  const task = taskOrUndef;

  const taskMap = Object.fromEntries(state.tasks.map(t => [t.id, t]));
  const projectMap = Object.fromEntries(state.projects.map(p => [p.id, p]));

  const blockedBy = state.links
    .filter(l => l.link_type === 'blocks' && l.to_task_id === task.id)
    .map(l => taskMap[l.from_task_id])
    .filter(Boolean) as Task[];

  const blocking = state.links
    .filter(l => l.link_type === 'blocks' && l.from_task_id === task.id)
    .map(l => taskMap[l.to_task_id])
    .filter(Boolean) as Task[];

  const related = state.links
    .filter(l => l.link_type === 'related' &&
      (l.from_task_id === task.id || l.to_task_id === task.id))
    .map(l => l.from_task_id === task.id ? taskMap[l.to_task_id] : taskMap[l.from_task_id])
    .filter(Boolean) as Task[];

  const projectName = task.project_id ? (projectMap[task.project_id]?.title ?? '') : '';

  const focused = !!task.focused_until && task.focused_until > new Date().toISOString();

  let statusLabel = '';
  if (focused) statusLabel = 'Focused';
  else if (task.snoozed_until && task.snoozed_until > new Date().toISOString())
    statusLabel = `Snoozed until ${task.snoozed_until.split('T')[0]}`;
  else if (task.due_date && task.due_date < today) statusLabel = `Overdue · ${task.due_date}`;

  async function handleDone() {
    const msg = await completeTaskAction(task.id, config, dispatch);
    if (msg) dispatch({ type: 'SET_TOAST', message: msg });
    dispatch({ type: 'SET_DETAIL', id: null });
  }

  async function handleStart() {
    await focusTaskAction(task.id, config, dispatch);
    dispatch({ type: 'SET_DETAIL', id: null });
  }

  function handleEdit() {
    dispatch({ type: 'SET_EDITING', id: task.id });
    pushNav({ view: state.currentView, detailId: task.id, editId: task.id });
  }

  function handleDetailLink(id: string) {
    dispatch({ type: 'SET_DETAIL', id });
    pushNav({ view: state.currentView, detailId: id, editId: null });
  }

  const hasLinks = blockedBy.length > 0 || blocking.length > 0 || related.length > 0;
  const hasActions = task.status === 'pending' || focused;

  return (
    <div className="detail-view">
      <button className="btn-back" onClick={() => history.back()}>← Back</button>

      <div className="detail-title">{task.title}</div>
      {statusLabel && <div className="detail-status">{statusLabel}</div>}
      {(task.due_date || task.recurrence) && (
        <div className="detail-meta">
          {task.due_date ? `Due ${task.due_date}` : ''}
          {task.due_date && task.recurrence ? ' · ' : ''}
          {task.recurrence ? 'Recurring' : ''}
        </div>
      )}
      {projectName && <div className="detail-meta">Project: {projectName}</div>}

      {hasActions && (
        <div className="card-actions">
          {!focused && task.status === 'pending' && (
            <>
              <button className="btn-act" style={{ flex: 2 }} onClick={handleStart}>Focus</button>
              <button className="btn-skip" style={{ flex: 1 }} onClick={handleDone}>Mark done</button>
            </>
          )}
          {focused && (
            <button className="btn-act" onClick={handleDone}>Mark done</button>
          )}
        </div>
      )}

      {task.kickoff_note && (
        <div className="detail-section">
          <div className="detail-section-label">Kickoff note</div>
          <Markdown src={task.kickoff_note} />
        </div>
      )}

      {task.notes && (
        <div className="detail-section">
          <div className="detail-section-label">Notes</div>
          <Markdown src={task.notes} />
        </div>
      )}

      {hasLinks && (
        <div className="detail-links">
          {blockedBy.length > 0 && (
            <LinkGroup label="Blocked by" tasks={blockedBy} onDetailLink={handleDetailLink} />
          )}
          {blocking.length > 0 && (
            <LinkGroup label="Blocking" tasks={blocking} onDetailLink={handleDetailLink} />
          )}
          {related.length > 0 && (
            <LinkGroup label="Related" tasks={related} onDetailLink={handleDetailLink} />
          )}
        </div>
      )}

      <button className="card-edit-link" onClick={handleEdit}>Edit ›</button>
    </div>
  );
}

function LinkGroup({ label, tasks, onDetailLink }: {
  label: string;
  tasks: Task[];
  onDetailLink: (id: string) => void;
}) {
  return (
    <div className="detail-link-group">
      <div className="detail-link-label">{label}</div>
      {tasks.map(t => (
        <div key={t.id} className="detail-link-item" onClick={() => onDetailLink(t.id)}>
          {t.title}
        </div>
      ))}
    </div>
  );
}
