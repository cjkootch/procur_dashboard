'use client';

import { useState, type ReactNode } from 'react';

/**
 * Toggleable text block for inbound communications. Renders the
 * English translation by default with a "Translated from [Lang]" chip;
 * click the chip to flip to the original. Re-click to flip back.
 *
 * No-op render when there's no translation (the source was already
 * English, or translation hasn't run yet) — falls through to the
 * original text. The chip simply doesn't render in that case.
 *
 * The component lets callers render the text however they want via
 * the `render` prop — `<pre>`, `<p>`, etc. — so the wrapper doesn't
 * impose layout. Defaults to a `<pre>` with the same whitespace
 * handling the inbox / messages views already use.
 */
export function TranslatableText({
  original,
  translation,
  languageName,
  className = '',
  render,
}: {
  original: string | null;
  translation: string | null;
  /** Human-readable name of the source language ("Spanish", "Portuguese"). */
  languageName: string | null;
  className?: string;
  /** Optional custom renderer. Receives the text to render; should
   *  return a JSX element. Defaults to a `<pre>` matching the inbox
   *  body styling. */
  render?: (text: string) => ReactNode;
}) {
  const hasTranslation = Boolean(translation);
  // Default view = English (the translation). Toggle flips to original.
  const [showOriginal, setShowOriginal] = useState(false);

  const text = (() => {
    if (!hasTranslation) return original ?? '';
    return showOriginal ? (original ?? '') : (translation ?? '');
  })();

  const renderNode = render
    ? render(text)
    : (
        <pre
          className={`whitespace-pre-wrap break-words font-sans text-sm leading-relaxed ${className}`}
        >
          {text}
        </pre>
      );

  return (
    <div>
      {hasTranslation && (
        <button
          type="button"
          onClick={() => setShowOriginal((v) => !v)}
          className="mb-1 inline-flex items-center gap-1 rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-foreground)] hover:text-[color:var(--color-foreground)]"
          title={
            showOriginal
              ? 'Show English translation'
              : `Show original (${languageName ?? 'source'})`
          }
        >
          {showOriginal
            ? `Original (${languageName ?? 'source'}) — show translation`
            : `Translated from ${languageName ?? 'source'}`}
        </button>
      )}
      {renderNode}
    </div>
  );
}
