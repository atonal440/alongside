import { SearchBar } from 'alongside-pwa';

const tasks = [
  { id: 't1', title: 'Review pull requests', status: 'pending', notes: null, due_date: null, recurrence: null, created_at: '', updated_at: '', defer_until: null, defer_kind: 'none', task_type: 'action', project_id: null, kickoff_note: null, session_log: null, focused_until: null },
  { id: 't2', title: 'Write the first draft', status: 'pending', notes: null, due_date: '2026-06-30', recurrence: null, created_at: '', updated_at: '', defer_until: null, defer_kind: 'none', task_type: 'action', project_id: 'p1', kickoff_note: null, session_log: null, focused_until: null },
  { id: 't3', title: 'Follow up with the team', status: 'pending', notes: null, due_date: null, recurrence: null, created_at: '', updated_at: '', defer_until: null, defer_kind: 'none', task_type: 'action', project_id: 'p1', kickoff_note: null, session_log: null, focused_until: null },
];

const projects = [
  { id: 'p1', title: 'Q3 Launch', color: null, created_at: '', updated_at: '' },
];

export function Closed() {
  return (
    <div style={{ padding: 16, maxWidth: 480 }}>
      <SearchBar
        tasks={tasks}
        projects={projects}
        onCreateTask={() => {}}
        onOpenTask={() => {}}
        onOpenProject={() => {}}
        onTaskAction={() => {}}
      />
    </div>
  );
}
