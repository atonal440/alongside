import type { Outcome } from './harness';

/**
 * Rows where the phase C adapter is allowed to differ from the legacy handler. Each entry carries
 * the adapter's expected outcome and why the difference is acceptable. Empty until adapters land;
 * a difference is added here only after it is approved.
 */
export const APPROVED_DIFFERENCES: Record<string, { reason: string; outcome: Outcome }> = {};
