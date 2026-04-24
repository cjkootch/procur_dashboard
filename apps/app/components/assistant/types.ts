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
  | { kind: 'contract'; id: string };
