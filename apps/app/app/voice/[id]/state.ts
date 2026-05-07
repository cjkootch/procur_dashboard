/**
 * Shared state shape for the /voice/[id] join action. Lives in its
 * own module (no `'use server'` directive) because Next.js 15
 * tightened the rule: `'use server'` files can ONLY export async
 * functions. Exporting a type or a const object from there is a
 * `Failed to collect page data` build error.
 *
 * Action implementation lives in ./actions.ts.
 */

export type JoinConferenceState =
  | { status: 'idle'; message: '' }
  | { status: 'success'; message: string; callSid: string }
  | { status: 'error'; message: string };

export const initialJoinConferenceState: JoinConferenceState = {
  status: 'idle',
  message: '',
};
