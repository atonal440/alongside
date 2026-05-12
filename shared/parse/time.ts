import { unsafeBrand } from '../brand';
import {
  parseIsoDate,
  parseIsoDateTime,
  parseIanaTimezone,
  type IanaTimezone,
  type IsoDate,
  type IsoDateTime,
} from './primitives';

export { parseIsoDate, parseIsoDateTime, parseIanaTimezone };
export type { IanaTimezone, IsoDate, IsoDateTime };

export function nowUtc(): IsoDateTime {
  return unsafeBrand<string, 'IsoDateTime'>(new Date().toISOString());
}

export function todayInTz(tz: IanaTimezone, date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return unsafeBrand<string, 'IsoDate'>(`${values['year']}-${values['month']}-${values['day']}`);
}

export function nowInTz(tz: IanaTimezone): { date: IsoDate; dateTime: IsoDateTime } {
  const current = new Date();
  return {
    date: todayInTz(tz, current),
    dateTime: unsafeBrand<string, 'IsoDateTime'>(current.toISOString()),
  };
}
