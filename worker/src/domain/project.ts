import type {
  BoundedString,
  IsoDateTime,
  NonEmptyString,
  ProjectId,
  ProjectStatus,
} from '../parse';

export interface ProjectDomain {
  id: ProjectId;
  title: NonEmptyString<200>;
  notes: BoundedString<10_000> | null;
  kickoffNote: BoundedString<2_000> | null;
  status: ProjectStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}
