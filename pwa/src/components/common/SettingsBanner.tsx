import { useState } from 'react';
import { useAppState } from '../../hooks/useAppState';

export function SettingsBanner() {
  const { state, dispatch } = useAppState();
  const [apiBase, setApiBase] = useState(state.apiBase);
  const [authToken, setAuthToken] = useState(state.authToken);

  if (state.syncStatus !== 'offline' && state.syncStatus !== 'idle') return null;
  // Only show banner when we've tried to sync and failed (offline after first attempt)
  if (state.syncStatus !== 'offline') return null;

  function handleConnect() {
    const trimmed = apiBase.replace(/\/$/, '');
    localStorage.setItem('alongside_api', trimmed);
    localStorage.setItem('alongside_token', authToken);
    dispatch({ type: 'SET_CONFIG', apiBase: trimmed, authToken });
  }

  return (
    <details className="settings-banner" open>
      <summary>Could not connect to worker</summary>
      <div className="fields">
        <label>Worker URL</label>
        <input
          value={apiBase}
          onChange={e => setApiBase(e.target.value)}
          placeholder="http://localhost:8787"
        />
        <label>Auth token</label>
        <input
          value={authToken}
          onChange={e => setAuthToken(e.target.value)}
          placeholder="dev-token-change-me"
        />
        <button onClick={handleConnect}>Connect</button>
      </div>
    </details>
  );
}
