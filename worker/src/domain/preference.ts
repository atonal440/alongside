import type { Result } from '@shared/result';
import { err, ok } from '@shared/result';
import type { InternalPreferenceKey, IsoDateTime, UserPreferenceKey, ValidationError } from '../parse';
import { parseIsoDateTime, parsePreferenceKey } from '../parse';

export type SortByPreference = 'readiness' | 'due' | 'project';
export type UrgencyVisibilityPreference = 'show' | 'hide';
export type KickoffNudgePreference = 'always' | 'missing' | 'never';
export type SessionLogPreference = 'ask_at_end' | 'auto_generate' | 'off';
export type InterruptionStylePreference = 'proactive' | 'quiet';
export type PlanningPromptPreference = 'auto' | 'always' | 'never';

export const SORT_BY_VALUES = ['readiness', 'due', 'project'] as const;
export const URGENCY_VISIBILITY_VALUES = ['show', 'hide'] as const;
export const KICKOFF_NUDGE_VALUES = ['always', 'missing', 'never'] as const;
export const SESSION_LOG_VALUES = ['ask_at_end', 'auto_generate', 'off'] as const;
export const INTERRUPTION_STYLE_VALUES = ['proactive', 'quiet'] as const;
export const PLANNING_PROMPT_VALUES = ['auto', 'always', 'never'] as const;

export type UserPreferenceEntry =
  | { key: UserPreferenceKey; name: 'sort_by'; value: SortByPreference }
  | { key: UserPreferenceKey; name: 'urgency_visibility'; value: UrgencyVisibilityPreference }
  | { key: UserPreferenceKey; name: 'kickoff_nudge'; value: KickoffNudgePreference }
  | { key: UserPreferenceKey; name: 'session_log'; value: SessionLogPreference }
  | { key: UserPreferenceKey; name: 'interruption_style'; value: InterruptionStylePreference }
  | { key: UserPreferenceKey; name: 'planning_prompt'; value: PlanningPromptPreference };

export type InternalPreferenceEntry = {
  key: InternalPreferenceKey;
  name: 'last_session_at';
  value: IsoDateTime;
};

export type PreferenceEntry = UserPreferenceEntry | InternalPreferenceEntry;

function withPath(prefix: string[], errors: ValidationError[]): ValidationError[] {
  return errors.map(error => ({ ...error, path: [...prefix, ...error.path] }));
}

function validationError(path: string[], code: string, message: string): ValidationError {
  return { path, code, message };
}

function isOneOf<const TValues extends readonly string[]>(
  values: TValues,
  value: string,
): value is TValues[number] {
  return values.includes(value);
}

function preferenceValueError(key: string, values: readonly string[]): ValidationError {
  return validationError(
    ['value'],
    'picklist',
    `${key} must be one of: ${values.join(', ')}.`,
  );
}

export function preferenceEntryFromParts(key: string, value: string): Result<PreferenceEntry, ValidationError[]> {
  const parsedKey = parsePreferenceKey(key);
  if (!parsedKey.ok) return err(withPath(['key'], parsedKey.error));

  switch (key) {
    case 'sort_by':
      return isOneOf(SORT_BY_VALUES, value)
        ? ok({ key: parsedKey.value as UserPreferenceKey, name: key, value })
        : err([preferenceValueError(key, SORT_BY_VALUES)]);
    case 'urgency_visibility':
      return isOneOf(URGENCY_VISIBILITY_VALUES, value)
        ? ok({ key: parsedKey.value as UserPreferenceKey, name: key, value })
        : err([preferenceValueError(key, URGENCY_VISIBILITY_VALUES)]);
    case 'kickoff_nudge':
      return isOneOf(KICKOFF_NUDGE_VALUES, value)
        ? ok({ key: parsedKey.value as UserPreferenceKey, name: key, value })
        : err([preferenceValueError(key, KICKOFF_NUDGE_VALUES)]);
    case 'session_log':
      return isOneOf(SESSION_LOG_VALUES, value)
        ? ok({ key: parsedKey.value as UserPreferenceKey, name: key, value })
        : err([preferenceValueError(key, SESSION_LOG_VALUES)]);
    case 'interruption_style':
      return isOneOf(INTERRUPTION_STYLE_VALUES, value)
        ? ok({ key: parsedKey.value as UserPreferenceKey, name: key, value })
        : err([preferenceValueError(key, INTERRUPTION_STYLE_VALUES)]);
    case 'planning_prompt':
      return isOneOf(PLANNING_PROMPT_VALUES, value)
        ? ok({ key: parsedKey.value as UserPreferenceKey, name: key, value })
        : err([preferenceValueError(key, PLANNING_PROMPT_VALUES)]);
    case 'last_session_at': {
      const parsedValue = parseIsoDateTime(value);
      return parsedValue.ok
        ? ok({ key: parsedKey.value as InternalPreferenceKey, name: key, value: parsedValue.value })
        : err(withPath(['value'], parsedValue.error));
    }
    default:
      return err([validationError(['key'], 'picklist', 'Unknown preference key.')]);
  }
}
