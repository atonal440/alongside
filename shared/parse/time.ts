import { unsafeBrand } from '../brand';
import {
  parseIsoDate,
  parseIsoDateTime,
  parseIanaTimezone,
  IanaTimezoneSchema,
  type IanaTimezone,
  type IsoDate,
  type IsoDateTime,
} from './primitives';

export { parseIsoDate, parseIsoDateTime, parseIanaTimezone };
export type { IanaTimezone, IsoDate, IsoDateTime };

/** A validated IANA zone shared by recurrence and planning intent. */
export type Timezone = IanaTimezone;
export const TimezoneSchema = IanaTimezoneSchema;
export const parseTimezone = parseIanaTimezone;

export function nowUtc(): IsoDateTime {
  return unsafeBrand<string, 'IsoDateTime'>(new Date().toISOString());
}
