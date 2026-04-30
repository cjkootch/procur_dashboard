export type RenderedToolUse = {
  id: string;
  name: string;
  input: unknown;
  result?: { output: unknown; isError: boolean };
};

/**
 * File attached to a user turn (image or PDF). The blob URL points at
 * Vercel Blob; Anthropic fetches the file directly via that URL when
 * we send it as an `image` or `document` content block.
 */
export type ChatAttachment = {
  url: string;
  contentType: string;
  filename: string;
};

export type RenderedMessage =
  | {
      id: string;
      kind: 'user';
      text: string;
      attachments?: ChatAttachment[];
    }
  | {
      id: string;
      kind: 'assistant';
      text: string;
      toolUses: RenderedToolUse[];
      /** True while this message is still being streamed. */
      streaming: boolean;
    };

export type PageContextInput =
  | { kind: 'pursuit'; id: string }
  | { kind: 'proposal'; id: string }
  | { kind: 'opportunity'; id: string }
  | { kind: 'contract'; id: string }
  /**
   * The user is viewing the known-entities rolodex with the listed
   * filters. The assistant should treat these as defaults for any
   * tool call where the same dimensions are accepted (e.g.
   * lookup_known_entities, find_recent_port_calls,
   * lookup_refineries_compatible_with_grade).
   */
  | {
      kind: 'rolodex';
      filters: {
        category?: string;
        country?: string;
        role?: string;
        tag?: string;
      };
    };
