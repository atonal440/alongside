import { useCallback, useEffect, useState } from 'react';
import type { RetainedOp } from '../../api/retainedOps';
import { idbGetRetainedOps } from '../../idb/retainedOps';
import { describeRetainedOp, discardRetainedOp, retryRetainedOp } from '../../sync/retained';
import { useAppState } from '../../hooks/useAppState';
import { requestSync } from '../../context/actions';

/** Changes the server refused, kept so the user can retry or discard them. Hidden when empty. */
export function RetainedOps() {
  const { state } = useAppState();
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
            <button onClick={() => act(retryRetainedOp, item.id!, requestSync)}>Retry</button>
            <button onClick={() => act(discardRetainedOp, item.id!)}>Discard</button>
          </div>
        </div>
      ))}
    </div>
  );
}
