import { DB } from './db';
import type { Env } from './index';
import { purgeExpiredOAuth } from './oauth';

/** The cron entry point: creates the instances due duties owe while no client is connected, then purges expired OAuth rows. Never throws. */
export async function handleScheduled(env: Env): Promise<void> {
  try {
    const summary = await new DB(env.DB).materializeDueDuties();
    if (summary.duties > 0 || summary.failed > 0) console.log(`duties: ${summary.instances} instance(s) for ${summary.duties} duty(ies), ${summary.failed} failed`);
  } catch (cause) {
    console.error('scheduled duty materialization failed', cause);
  }
  try {
    await purgeExpiredOAuth(env.DB);
  } catch (cause) {
    console.error('scheduled oauth purge failed', cause);
  }
}
