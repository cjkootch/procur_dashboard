'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { usePathname } from 'next/navigation';
import { Button } from '@procur/ui';

/**
 * Pattern 3 (friction logging) per docs/feedback-ui-brief.md §6.
 * Floating "Stuck?" button bottom-right + global `?` keyboard
 * shortcut. Click or shortcut opens an inline overlay (not modal)
 * with a textarea + auto-captured context.
 *
 * Mounted once at the app root layout so every page gets it. The
 * shortcut deliberately doesn't fire while typing in another
 * input — `?` is also a search character.
 */
export function FrictionButton() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, startTransition] = useTransition();
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.metaKey || e.altKey) return;
      if (e.key === '?' || (e.ctrlKey && e.key === '/')) {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (open && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [open]);

  const submit = () => {
    if (draft.trim().length < 3) return;
    startTransition(async () => {
      const res = await fetch('/api/feedback/friction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: draft.trim(),
          context: {
            page: pathname,
            recent_navigation:
              typeof window !== 'undefined'
                ? [document.referrer || null].filter(Boolean)
                : null,
            timestamp: new Date().toISOString(),
          },
        }),
      });
      if (res.ok) {
        setConfirmation('logged');
        setDraft('');
        setOpen(false);
        setTimeout(() => setConfirmation(null), 2_500);
      }
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Tell us what's not working  [? or Ctrl+/]"
        aria-label="Log friction"
        // Sized to match the AssistantDrawer's Ask launcher (px-4 py-2.5
        // text-sm) so the two stacked launchers feel like a paired
        // affordance instead of two unrelated chips. `transition` +
        // `-translate-y-px` give a subtle hover-lift; the dark fill
        // distinguishes it from Ask's light pill below.
        className="fixed bottom-20 right-4 z-40 flex items-center gap-2 rounded-full bg-[color:var(--color-foreground)] px-4 py-2.5 text-sm font-medium text-[color:var(--color-background)] shadow-lg transition hover:-translate-y-px hover:shadow-xl"
      >
        <span className="text-rose-400" aria-hidden>
          ?
        </span>
        <span>Stuck?</span>
      </button>

      {confirmation && (
        <div className="fixed bottom-32 right-4 z-50 rounded-md border border-emerald-500/40 bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800 shadow-sm">
          ✓ Friction logged
        </div>
      )}

      {open && (
        <div className="fixed bottom-32 right-4 z-50 w-[360px] rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-3 shadow-xl">
          <div className="mb-1.5 text-sm font-medium">What did you wish the system would do?</div>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
              if (e.key === 'Escape') setOpen(false);
            }}
            placeholder="One sentence works. Cmd+Enter to save, Esc to cancel."
            rows={3}
            disabled={pending}
            className="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 px-2 py-1 text-sm focus:border-[color:var(--color-foreground)] focus:outline-none"
          />
          <div className="mt-2 text-[10px] text-[color:var(--color-muted-foreground)]">
            Context auto-captured: page <span className="font-mono">{pathname}</span>, time, referrer.
          </div>
          <div className="mt-2 flex justify-end gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Skip
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={submit}
              disabled={pending || draft.trim().length < 3}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
