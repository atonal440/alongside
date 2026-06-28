import { TaskCard } from 'alongside-pwa';

const baseFlow = {
  taskId: 't1',
  emphasis: 'primary',
  metaLabel: null,
  projectLabel: '',
  projectColor: '',
  dueLabel: '',
  readiness: 0.8,
  notePreview: '',
  relationships: { blockedBy: [], unlocks: [] },
  secondaryActions: [
    { id: 'edit', label: 'Edit', tone: 'secondary' },
    { id: 'defer', label: 'Defer', tone: 'secondary' },
  ],
};

export function Ready() {
  return (
    <div style={{ maxWidth: 400, padding: 16 }}>
      <TaskCard
        flow={{
          ...baseFlow,
          mode: 'ready',
          statusLabel: 'Ready',
          title: 'Write the quarterly review',
          kickoff: 'Start with the key metrics from last quarter.',
          primaryAction: { id: 'focus', label: 'Focus', tone: 'primary' },
        }}
        onAction={() => {}}
      />
    </div>
  );
}

export function Focused() {
  return (
    <div style={{ maxWidth: 400, padding: 16 }}>
      <TaskCard
        flow={{
          ...baseFlow,
          taskId: 't2',
          mode: 'focused',
          statusLabel: 'Focused',
          title: 'Review open pull requests',
          kickoff: 'Check the three oldest ones first.',
          notePreview: 'Look for anything blocked on review.',
          primaryAction: { id: 'complete', label: 'Done', tone: 'primary' },
        }}
        onAction={() => {}}
      />
    </div>
  );
}

export function Blocked() {
  return (
    <div style={{ maxWidth: 400, padding: 16 }}>
      <TaskCard
        flow={{
          ...baseFlow,
          taskId: 't3',
          mode: 'blocked',
          emphasis: 'muted',
          statusLabel: 'Blocked',
          title: 'Deploy to production',
          kickoff: 'Waiting on sign-off from the team.',
          primaryAction: undefined,
          relationships: { blockedBy: ['Review pull requests'], unlocks: [] },
        }}
        onAction={() => {}}
      />
    </div>
  );
}
