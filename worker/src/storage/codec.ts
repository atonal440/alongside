import type { Result } from '@shared/result';
import type { ValidationError } from '@shared/parse';

export type CodecResult<T> = Result<T, ValidationError[]>;

export interface StorageCodec<Row, Domain> {
  fromRow(row: Row): CodecResult<Domain>;
  toRow(domain: Domain): Row;
}
