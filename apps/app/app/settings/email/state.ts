/**
 * Shared state shape for the /settings/email save action. Lives in
 * its own module (no `'use server'` directive) because Next.js 15
 * `'use server'` files can ONLY export async functions — type and
 * const exports there cause a `Failed to collect page data` build
 * error.
 *
 * Action implementation lives in ./actions.ts.
 */

export type SaveEmailSettingsState = {
  status: 'idle' | 'success' | 'error';
  message: string;
  savedAt?: string;
};

export const initialSaveEmailSettingsState: SaveEmailSettingsState = {
  status: 'idle',
  message: '',
};
