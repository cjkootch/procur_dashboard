/**
 * The threads helpers used to live here. They moved to `@procur/ai`
 * (packages/ai/src/threads.ts) so the Discover widget can persist
 * conversations server-side too — Discover can't import from
 * `apps/app/lib`. This file re-exports the shared surface so the
 * existing `lib/assistant/threads` import paths inside this app keep
 * working.
 */
export {
  listThreads,
  getThread,
  listMessages,
  createThread,
  renameThread,
  deleteThread,
  appendUserMessage,
  appendAssistantMessage,
  appendToolResults,
  messagesToHistory,
  type ThreadListRow,
  type UserAttachment,
  type AppendAssistantMessageInput,
} from '@procur/ai';
