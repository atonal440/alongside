import { useAppState } from '../../hooks/useAppState';

export function SyncStatus() {
  const { state } = useAppState();
  const offline = state.syncStatus === 'offline';
  return (
    <div className={`sync-status${offline ? ' offline' : ''}`}>
      {offline ? 'offline - changes saved locally' : 'synced'}
    </div>
  );
}
