import {
  messageSender,
  quietNoteOf,
  type OrchestratorMcpThreadTimelineItem,
} from "@t3tools/contracts";

export const threadMessageOrigin = (item: OrchestratorMcpThreadTimelineItem) => ({
  ...(item.createdBy === null ? {} : { createdBy: item.createdBy }),
  ...(item.creationSource === null ? {} : { creationSource: item.creationSource }),
  ...messageSender(item),
  ...quietNoteOf(item),
  ...(item.notification === undefined ? {} : { notification: item.notification }),
  ...(item.delegatedCompletion === undefined
    ? {}
    : { delegatedCompletion: item.delegatedCompletion }),
});
