import { EmptyState } from 'alongside-pwa';

export function Default() {
  return <EmptyState message="No tasks ready right now" />;
}

export function CaughtUp() {
  return <EmptyState message="You're all caught up — nothing pending" />;
}

export function AddPrompt() {
  return <EmptyState message="Add a task to get started" />;
}
