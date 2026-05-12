import type { InternalPreferenceKey, IsoDateTime, UserPreferenceKey } from '../parse';

export type SortByPreference = 'readiness' | 'due' | 'project';
export type UrgencyVisibilityPreference = 'show' | 'hide';
export type KickoffNudgePreference = 'always' | 'missing' | 'never';
export type SessionLogPreference = 'ask_at_end' | 'auto_generate' | 'off';
export type InterruptionStylePreference = 'proactive' | 'quiet';
export type PlanningPromptPreference = 'auto' | 'always' | 'never';

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
