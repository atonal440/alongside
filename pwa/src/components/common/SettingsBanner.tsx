import { useEffect, useState } from 'react';
import { useAppState } from '../../hooks/useAppState';
import { verifyApiConfig } from '../../api/client';

export function SettingsBanner() {
  const { state, dispatch } = useAppState();
  const [apiBase, setApiBase] = useState(state.apiBase);
  const [authToken, setAuthToken] = useState(state.authToken);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const isConfigured = Boolean(state.apiBase && state.authToken);
  const canConnect = Boolean(apiBase.trim() && authToken.trim()) && !isConnecting;

  useEffect(() => {
    setApiBase(state.apiBase);
    setAuthToken(state.authToken);
  }, [state.apiBase, state.authToken]);

  if (isConfigured) return null;

  async function handleConnect() {
    const trimmed = apiBase.replace(/\/$/, '');
    const token = authToken.trim();
    if (!trimmed || !token) return;

    setIsConnecting(true);
    setConnectError(null);
    const verified = await verifyApiConfig({ apiBase: trimmed, authToken: token });
    setIsConnecting(false);

    if (!verified) {
      setConnectError('Could not verify that worker URL and token.');
      return;
    }

    localStorage.setItem('alongside_api', trimmed);
    localStorage.setItem('alongside_token', token);
    localStorage.removeItem('alongside_logged_out');
    dispatch({ type: 'SET_CONFIG', apiBase: trimmed, authToken: token });
  }

  return (
    <details className="settings-banner" open>
      <summary>Logged out</summary>
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
        {connectError && <p className="settings-error">{connectError}</p>}
        <button onClick={handleConnect} disabled={!canConnect}>
          {isConnecting ? 'Checking...' : 'Connect'}
        </button>
      </div>
    </details>
  );
}
