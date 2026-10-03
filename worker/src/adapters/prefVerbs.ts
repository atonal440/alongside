/** update_preference as an adapter over the preference.set command. It never logs, as before. */
import { refuse, type Compiler } from './runner';

export const updatePreference: Compiler = async (ctx, args) => {
  if (typeof args.key !== 'string') throw refuse('key must be a string.', ['key']);
  const state = await ctx.db.readPreferenceState(args.key);
  return { kind: 'commands', commands: [{ kind: 'preference.set', key: args.key, value: args.value, expectedRevision: ctx.expectedRevision === undefined ? state.revision : ctx.expectedRevision }],
    respond: () => ({ response: { updated: true, key: args.key, value: args.value }, log: null }) };
};
