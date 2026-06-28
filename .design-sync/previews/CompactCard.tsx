import { CompactCard } from 'alongside-pwa';

const today = '2026-06-28';

const pending = {
  id: 't1', title: 'Follow up with the team', status: 'pending',
  notes: null, due_date: null, recurrence: null, created_at: '', updated_at: '',
  defer_until: null, defer_kind: 'none', task_type: 'action',
  project_id: null, kickoff_note: null, session_log: null, focused_until: null,
};

const overdue = {
  ...pending, id: 't2', title: 'Send the invoice', due_date: '2026-06-25',
};

const done = {
  ...pending, id: 't3', title: 'Book the flight', status: 'done',
};

const focused = {
  ...pending, id: 't4', title: 'Write the proposal',
  focused_until: new Date(Date.now() + 3600000).toISOString(),
};

export function Pending() {
  return (
    <div style={{ maxWidth: 400, padding: 16 }}>
      <CompactCard task={pending} today={today} onComplete={() => {}} onDetail={() => {}} />
    </div>
  );
}

export function Overdue() {
  return (
    <div style={{ maxWidth: 400, padding: 16 }}>
      <CompactCard task={overdue} today={today} onComplete={() => {}} onDetail={() => {}} />
    </div>
  );
}

export function Done() {
  return (
    <div style={{ maxWidth: 400, padding: 16 }}>
      <CompactCard task={done} today={today} onComplete={() => {}} onDetail={() => {}} />
    </div>
  );
}

export function InFocus() {
  return (
    <div style={{ maxWidth: 400, padding: 16 }}>
      <CompactCard task={focused} today={today} onComplete={() => {}} onDetail={() => {}} />
    </div>
  );
}
