'use client';

import { useState } from 'react';

/**
 * Reusable copy-as-markdown / download-as-.md toolbar. Generalises
 * the pattern from ChatToolbar — pages compose their own markdown
 * snapshot server-side and pass it as the `markdown` prop. Operator
 * clicks Copy → clipboard, or Download → .md file.
 *
 * Use this any time an operator might want to paste a page's state
 * into a chat / GitHub issue / debugging session instead of taking
 * a screenshot.
 */
interface Props {
  /** The markdown text to copy / download. Compose server-side and
   *  pass in fully-rendered. */
  markdown: string;
  /** Used in the downloaded filename: procur-{slug}-{date}.md */
  slug: string;
  /** Optional override for the Copy button label. Default: "Copy as Markdown". */
  label?: string;
  /** Hover tooltip text. */
  title?: string;
}

export function CopyMarkdownToolbar({ markdown, slug, label, title }: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for browsers that block the clipboard API: open the
      // raw text in a new window so the operator can copy manually.
      const w = window.open('', '_blank');
      if (w) {
        w.document.title = `procur ${slug} export`;
        const pre = w.document.createElement('pre');
        pre.textContent = markdown;
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.padding = '16px';
        pre.style.fontFamily = 'ui-monospace, monospace';
        w.document.body.appendChild(pre);
      }
    }
  };

  const onDownload = () => {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `procur-${slug}-${date}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="mb-3 flex items-center justify-end gap-1">
      <button
        type="button"
        onClick={() => void onCopy()}
        title={title ?? 'Copy this page as Markdown to paste elsewhere'}
        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-[11px] text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-foreground)] hover:text-[color:var(--color-foreground)]"
      >
        {copied ? '✓ Copied' : (label ?? 'Copy as Markdown')}
      </button>
      <button
        type="button"
        onClick={onDownload}
        title="Download this page as a .md file"
        className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-[11px] text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-foreground)] hover:text-[color:var(--color-foreground)]"
      >
        Download .md
      </button>
    </div>
  );
}
