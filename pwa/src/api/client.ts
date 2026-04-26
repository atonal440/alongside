export interface ApiConfig {
  apiBase: string;
  authToken: string;
}

export async function apiFetch(
  path: string,
  options: RequestInit = {},
  config: ApiConfig,
): Promise<unknown> {
  if (!config.apiBase) return null;
  try {
    const res = await fetch(`${config.apiBase}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.authToken}`,
        ...(options.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  } catch (e) {
    console.warn('API fetch failed:', e);
    return null;
  }
}

export async function verifyApiConfig(config: ApiConfig): Promise<boolean> {
  if (!config.apiBase || !config.authToken) return false;

  try {
    const res = await fetch(`${config.apiBase}/`, {
      headers: {
        Authorization: `Bearer ${config.authToken}`,
      },
    });
    return res.ok;
  } catch (e) {
    console.warn('API verification failed:', e);
    return false;
  }
}
