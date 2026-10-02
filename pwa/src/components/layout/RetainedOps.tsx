import { useCallback, useEffect, useState } from 'react';
import type { RetainedOp } from '../../api/retainedOps';
import { idbGetRetainedOps } from '../../idb/retainedOps';
import type { Task } from '../../types';
import { describeRetainedOp, discardRetainedOp, rebaseView, retryRebased, retryRetainedOp } from '../../sync/retained';
import { useAppState } from '../../hooks/useAppState';
import { requestSync } from '../../context/actions';

const show = (value: unknown): string => (value === null || value === undefined ? '(empty)' : String(value));

/** Field-by-field choice for a refused edit: keep only the changes that still make sense. */
function Rebase({ item, tasks, apiBase, onDone }: { item: RetainedOp; tasks: readonly Task[]; apiBase: string; onDone: () => void }) {
  const view = rebaseView(item, tasks);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(view.kind === 'fields' ? view.fields.filter(f => f.differs).map(f => f.field) : []));
  if (view.kind !== 'fields') return null;
  const toggle = (field: string) => setPicked(prev => { const next = new Set(prev); if (!next.delete(field)) next.add(field); return next; });
  return (
    <div className="retained-rebase">
      {view.fields.map(f => (
        <label key={f.field} className="retained-field">
          <input type="checkbox" checked={picked.has(f.field)} disabled={!f.differs} onChange={() => toggle(f.field)} />
          <span>{f.field}: {show(f.current)} → {show(f.intended)}{f.differs ? '' : ' (already set)'}</span>
        </label>
      ))}
      <button onClick={() => { retryRebased(item.id!, [...picked], apiBase).then(() => { onDone(); requestSync(); }, onDone); }}>
        {picked.size > 0 ? 'Retry selected' : 'Discard all'}
      </button>
    </div>
  );
}

/** Changes the server refused, kept so the user can retry or discard them. Hidden when empty. */
export function RetainedOps() {
  const { state } = useAppState();
  const [reviewing, setReviewing] = useState<number | null>(null);
  const [items, setItems] = useState<RetainedOp[]>([]);
  const refresh = useCallback(() => { idbGetRetainedOps().then(setItems, () => setItems([])); }, []);
  // Re-read after each sync cycle: that is when the flush can retain new ops.
  useEffect(refresh, [refresh, state.syncStatus]);
  if (items.length === 0) return null;

  const act = (run: (id: number) => Promise<number>, id: number, after?: () => void) => {
    run(id).then(() => { refresh(); after?.(); }, () => refresh());
  };

  return (
    <div className="sidebar-section retained-ops">
      <div className="sidebar-label">Needs attention ({items.length})</div>
      {items.map(item => (
        <div className="retained-op" key={item.id}>
          <div className="retained-op-title">{describeRetainedOp(item)}</div>
          <div className="retained-op-reason">{item.reason.message}</div>
          <div className="retained-op-actions">
            {/* A dependent is retried through the refused op it waits on. */}
            {item.reason.kind !== 'dependency' && rebaseView(item, state.tasks).kind === 'fields' && <button onClick={() => setReviewing(reviewing === item.id ? null : item.id!)}>Review</button>}
            {item.reason.kind !== 'dependency' && rebaseView(item, state.tasks).kind !== 'missing' && <button onClick={() => act(id => retryRetainedOp(id, state.apiBase), item.id!, requestSync)}>Retry</button>}
            <button onClick={() => act(discardRetainedOp, item.id!)}>Discard</button>
          </div>
          {reviewing === item.id && <Rebase item={item} tasks={state.tasks} apiBase={state.apiBase} onDone={() => { setReviewing(null); refresh(); }} />}
        </div>
      ))}
    </div>
  );
}
