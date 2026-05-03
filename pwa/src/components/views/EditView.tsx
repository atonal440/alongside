import { useState } from 'react';
import { useAppState } from '../../hooks/useAppState';
import { updateTaskAction, deleteTaskAction, createLinkAction, deleteLinkAction } from '../../context/actions';
import type { TaskLink } from '../../types';

export function EditView() {
  const { state, dispatch } = useAppState();
  const config = { apiBase: state.apiBase, authToken: state.authToken };

  const task = state.tasks.find(t => t.id === state.editingTaskId);
  if (!task) return null;

  const taskLinks = state.links.filter(
    l => l.from_task_id === task.id || l.to_task_id === task.id,
  );
  const otherTasks = state.tasks.filter(t => t.id !== task.id && t.status !== 'done');
  const taskMap = Object.fromEntries(state.tasks.map(t => [t.id, t]));

  return (
    <EditForm
      key={task.id}
      task={{
        id: task.id,
        title: task.title,
        notes: task.notes,
        kickoff_note: task.kickoff_note,
        due_date: task.due_date,
        recurrence: task.recurrence,
        session_log: task.session_log,
        defer_kind: task.defer_kind,
        defer_until: task.defer_until,
      }}
      taskLinks={taskLinks}
      otherTasks={otherTasks}
      taskMap={taskMap}
      onSave={async (updates) => {
        await updateTaskAction(task.id, updates, config, dispatch);
        dispatch({ type: 'SET_EDITING', id: null });
      }}
      onCancel={() => history.back()}
      onDelete={async () => {
        if (confirm('Delete this task?')) {
          await deleteTaskAction(task.id, config, dispatch);
          dispatch({ type: 'SET_EDITING', id: null });
          dispatch({ type: 'SET_DETAIL', id: null });
        }
      }}
      onAddLink={async (toId, linkType) => {
        await createLinkAction(task.id, toId, linkType, config, dispatch);
      }}
      onRemoveLink={async (fromId, toId, linkType) => {
        await deleteLinkAction(fromId, toId, linkType, config, dispatch);
      }}
    />
  );
}

interface EditFormProps {
  task: {
    id: string;
    title: string;
    notes: string | null;
    kickoff_note: string | null;
    due_date: string | null;
    recurrence: string | null;
    session_log: string | null;
    defer_kind: 'none' | 'until' | 'someday';
    defer_until: string | null;
  };
  taskLinks: TaskLink[];
  otherTasks: { id: string; title: string }[];
  taskMap: Record<string, { id: string; title: string }>;
  onSave: (updates: {
    title: string;
    notes: string | null;
    kickoff_note: string | null;
    due_date: string | null;
    recurrence: string | null;
    session_log: string | null;
    defer_kind: 'none' | 'until' | 'someday';
    defer_until: string | null;
  }) => Promise<void>;
  onCancel: () => void;
  onDelete: () => Promise<void>;
  onAddLink: (toId: string, linkType: TaskLink['link_type']) => Promise<void>;
  onRemoveLink: (fromId: string, toId: string, linkType: TaskLink['link_type']) => Promise<void>;
}

type DeferKind = EditFormProps['task']['defer_kind'];

function EditForm({ task, taskLinks, otherTasks, taskMap, onSave, onCancel, onDelete, onAddLink, onRemoveLink }: EditFormProps) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? '');
  const [kickoff, setKickoff] = useState(task.kickoff_note ?? '');
  const [dueDate, setDueDate] = useState(task.due_date ?? '');
  const [recurrence, setRecurrence] = useState(task.recurrence ?? '');
  const [sessionLog, setSessionLog] = useState(task.session_log ?? '');
  const [deferKind, setDeferKind] = useState(task.defer_kind);
  const [deferUntil, setDeferUntil] = useState(task.defer_until?.split('T')[0] ?? '');
  const [linkToId, setLinkToId] = useState('');
  const [linkType, setLinkType] = useState<TaskLink['link_type']>('blocks');

  return (
    <div className="edit-form">
      <label>Title</label>
      <input type="text" value={title} onChange={e => setTitle(e.target.value)} />
      <label>Notes</label>
      <textarea value={notes} onChange={e => setNotes(e.target.value)} />
      <label>
        Kickoff note{' '}
        <span style={{ fontWeight: 'normal', color: 'var(--text-dim)' }}>(what do you need to start?)</span>
      </label>
      <textarea value={kickoff} onChange={e => setKickoff(e.target.value)} />
      <label>Due date</label>
      <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
      <label>Recurrence</label>
      <select value={recurrence} onChange={e => setRecurrence(e.target.value)}>
        <option value="">None</option>
        <option value="FREQ=DAILY;INTERVAL=1">Daily</option>
        <option value="FREQ=WEEKLY;INTERVAL=1">Weekly</option>
        <option value="FREQ=MONTHLY;INTERVAL=1">Monthly</option>
      </select>
      <label>Defer</label>
      <select value={deferKind} onChange={e => setDeferKind(e.target.value as DeferKind)}>
        <option value="none">None</option>
        <option value="until">Until…</option>
        <option value="someday">Someday</option>
      </select>
      {deferKind === 'until' && (
        <input type="date" value={deferUntil} onChange={e => setDeferUntil(e.target.value)} />
      )}
      <label>Session note</label>
      <textarea value={sessionLog} onChange={e => setSessionLog(e.target.value)} />
      <label>Relationships</label>
      <div id="link-list">
        {taskLinks.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>None</div>
        ) : (
          taskLinks.map(l => {
            const otherId = l.from_task_id === task.id ? l.to_task_id : l.from_task_id;
            const other = taskMap[otherId];
            const desc = l.from_task_id === task.id
              ? `Blocks: ${other?.title ?? otherId}`
              : `Blocked by: ${other?.title ?? otherId}`;
            return (
              <div key={`${l.from_task_id}-${l.to_task_id}-${l.link_type}`} className="link-item">
                <span>{desc}</span>
                <button
                  className="link-remove"
                  onClick={() => onRemoveLink(l.from_task_id, l.to_task_id, l.link_type)}
                >
                  ✕
                </button>
              </div>
            );
          })
        )}
      </div>
      {otherTasks.length > 0 && (
        <div className="link-add-row">
          <select value={linkToId} onChange={e => setLinkToId(e.target.value)}>
            <option value="">— add relationship —</option>
            {otherTasks.map(t => (
              <option key={t.id} value={t.id}>{t.title}</option>
            ))}
          </select>
          <select
            value={linkType}
            onChange={e => setLinkType(e.target.value as TaskLink['link_type'])}
          >
            <option value="blocks">Blocks it</option>
            <option value="related">Related</option>
          </select>
          <button onClick={async () => {
            if (!linkToId) return;
            await onAddLink(linkToId, linkType);
            setLinkToId('');
          }}>
            Add
          </button>
        </div>
      )}
      <div className="edit-actions">
        <button
          className="btn-save"
          onClick={() => onSave({
            title,
            notes: notes || null,
            kickoff_note: kickoff || null,
            due_date: dueDate || null,
            recurrence: recurrence || null,
            session_log: sessionLog || null,
            defer_kind: deferKind,
            defer_until: deferKind === 'until' && deferUntil
              ? new Date(`${deferUntil}T09:00:00`).toISOString()
              : null,
          })}
        >
          Save
        </button>
        <button className="btn-cancel" onClick={onCancel}>Cancel</button>
        <button className="btn-delete" onClick={onDelete}>Delete</button>
      </div>
    </div>
  );
}
