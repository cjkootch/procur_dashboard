export type RenderedToolUse = {
  id: string;
  name: string;
  input: unknown;
  result?: { output: unknown; isError: boolean };
};

export type RenderedMessage =
  | { id: string; kind: 'user'; text: string }
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
