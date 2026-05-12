import type { LinkType, TaskId } from '../parse';

export interface TaskLinkDomain {
  from: TaskId;
  to: TaskId;
  linkType: LinkType;
}
