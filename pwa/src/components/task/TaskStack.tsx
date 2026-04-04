import type { Task } from '../../types';
import { CompactCard } from './CompactCard';

interface Props {
  root: Task;
  blocked: Task[];
  today: string;
  onComplete: (id: string) => void;
  onDetail: (id: string) => void;
}

export function TaskStack({ root, blocked, today, onComplete, onDetail }: Props) {
  const [first, second] = blocked;
  return (
    <div className="task-stack">
      <CompactCard task={root} today={today} onComplete={onComplete} onDetail={onDetail} />
      {first && <CompactCard task={first} today={today} cssClass="blocked-1" />}
      {second && <CompactCard task={second} today={today} cssClass="blocked-2" />}
    </div>
  );
}
