import { TaskStack } from 'alongside-pwa';

const today = '2026-06-28';

const base = {
  status: 'pending', notes: null, due_date: null, recurrence: null,
  created_at: '', updated_at: '', defer_until: null, defer_kind: 'none',
  task_type: 'action', project_id: null, kickoff_note: null, session_log: null, focused_until: null,
};

const root = { ...base, id: 'r1', title: 'Launch the Q3 feature' };

const blocked = [
  { ...base, id: 'b1', title: 'Write release notes' },
  { ...base, id: 'b2', title: 'Update the docs' },
  { ...base, id: 'b3', title: 'Notify the team' },
];

export function Collapsed() {
  return (
    <div style={{ maxWidth: 400, padding: 16 }}>
      <TaskStack root={root} blocked={blocked} today={today} onComplete={() => {}} onDetail={() => {}} />
    </div>
  );
}

export function TwoLinked() {
  return (
    <div style={{ maxWidth: 400, padding: 16 }}>
      <TaskStack
        root={{ ...base, id: 'r2', title: 'Ship the migration' }}
        blocked={[
          { ...base, id: 'b4', title: 'Run the backfill script' },
          { ...base, id: 'b5', title: 'Verify data integrity' },
        ]}
        today={today}
        onComplete={() => {}}
        onDetail={() => {}}
      />
    </div>
  );
}
