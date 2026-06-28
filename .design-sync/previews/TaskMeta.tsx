import { TaskMeta } from 'alongside-pwa';

const base = {
  id: 't1', title: 'Example task', status: 'pending',
  notes: null, recurrence: null, created_at: '', updated_at: '',
  defer_until: null, defer_kind: 'none', task_type: 'action',
  project_id: null, kickoff_note: null, session_log: null, focused_until: null,
};

const today = '2026-06-28';

export function DueToday() {
  return <TaskMeta task={{ ...base, due_date: today }} today={today} />;
}

export function Overdue() {
  return <TaskMeta task={{ ...base, due_date: '2026-06-20' }} today={today} />;
}

export function UpcomingDate() {
  return <TaskMeta task={{ ...base, due_date: '2026-07-05' }} today={today} />;
}

export function Recurring() {
  return <TaskMeta task={{ ...base, due_date: today, recurrence: 'FREQ=WEEKLY' }} today={today} />;
}

export function NoMeta() {
  return (
    <div>
      <TaskMeta task={{ ...base, due_date: null }} today={today} />
      <span style={{ color: 'var(--ink-4)', fontSize: 12 }}>(renders nothing)</span>
    </div>
  );
}
