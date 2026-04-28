'use client';

import { useEffect } from 'react';
import {
  readHandshakeFromUrl,
  scrubHandshakeFromUrl,
  setStoredToken,
} from '../lib/assistant-token';

/**
 * Mounted once at the layout root. On first render, reads any handshake
 * token from the URL hash, persists it, and removes it from the URL so
 * a refresh doesn't re-store the same value (and the token doesn't
 * appear in browser history).
 *
 * Renders nothing — pure side-effect component.
 */
export function AssistantBootstrap() {
  useEffect(() => {
    const token = readHandshakeFromUrl();
    if (token) {
      setStoredToken(token);
      scrubHandshakeFromUrl();
      // Notify the widget so it picks up the new token without a refresh.
      window.dispatchEvent(new CustomEvent('procur:discover-token-updated'));
    }
  }, []);
  return null;
}
