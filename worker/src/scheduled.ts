import { DB } from './db';
import type { Env } from './index';

/** The cron entry point: creates the instances due duties owe while no client is connected. Never throws. */
export async function handleScheduled(env: Env): Promise<void> {
  try {
    const summary = await new DB(env.DB).materializeDueDuties();
    if (summary.duties > 0 || summary.failed > 0) console.log(`duties: ${summary.instances} instance(s) for ${summary.duties} duty(ies), ${summary.failed} failed`);
  } catch (cause) {
    console.error('scheduled duty materialization failed', cause);
  }
}
