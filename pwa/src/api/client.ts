import type { ValidationError } from '@shared/parse';
import type { Result } from '@shared/result';
import type { ApiResult, ApiErrorBody } from './result';
import { CLIENT_HEADER, CLIENT_PROTOCOL, UPGRADE_REQUIRED_STATUS, formatClientAnnouncement } from '@shared/wire/clientVersion';

// Set when the server refuses this build as too old. The sync loop reads it once per cycle to tell
// the user to reload; queued work is kept because 426 is treated as a transient failure.
let upgradeRequired = false;
export const consumeUpgradeRequired = (): boolean => { const was = upgradeRequired; upgradeRequired = false; return was; };

export interface ApiConfig {
  apiBase: string;
  authToken: string;
}

type BodyParser<T> = (raw: unknown) => Result<T, ValidationError[]>;

export async function apiRequest<T>(
  path: string,
  init: RequestInit,
  config: ApiConfig,
  parseBody: BodyParser<T>,
  parseErrorBody?: BodyParser<ApiErrorBody>,
): Promise<ApiResult<T>> {
  if (!config.apiBase) return { kind: 'unconfigured' };

  let res: Response;
  try {
    res = await fetch(`${config.apiBase}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.authToken}`,
        [CLIENT_HEADER]: formatClientAnnouncement('pwa', CLIENT_PROTOCOL),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch {
    return { kind: 'network' };
  }

  if (!res.ok) {
    if (res.status === UPGRADE_REQUIRED_STATUS) upgradeRequired = true;
    let body: ApiErrorBody;
    try {
      const raw = await res.json() as unknown;
      const obj = raw as Record<string, unknown>;
      if (parseErrorBody) {
        const parsedError = parseErrorBody(raw);
        if (!parsedError.ok) return { kind: 'contract', status: res.status, issues: parsedError.error, raw };
        body = parsedError.value;
      } else if (raw !== null && typeof raw === 'object' && typeof obj['error'] === 'string') {
        body = raw as ApiErrorBody;
      } else {
        body = { error: `HTTP ${res.status}` };
      }
    } catch {
      body = { error: `HTTP ${res.status}` };
    }
    return { kind: 'http', status: res.status, body };
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    const issues: ValidationError[] = [
      { path: [], code: 'invalid_json', message: 'Response body is not valid JSON.' },
    ];
    console.error('[api] contract violation:', issues);
    return { kind: 'contract', status: res.status, issues, raw: undefined };
  }

  const parsed = parseBody(raw);
  if (!parsed.ok) {
    console.error('[api] contract violation:', parsed.error);
    return { kind: 'contract', status: res.status, issues: parsed.error, raw };
  }

  return { kind: 'ok', value: parsed.value };
}

export async function verifyApiConfig(config: ApiConfig): Promise<boolean> {
  if (!config.apiBase || !config.authToken) return false;
  try {
    const res = await fetch(`${config.apiBase}/`, {
      headers: { Authorization: `Bearer ${config.authToken}` },
    });
    return res.ok;
  } catch {
    console.warn('API verification failed');
    return false;
  }
}
