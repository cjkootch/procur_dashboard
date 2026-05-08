'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';

/**
 * Inline approval card rendered when a propose-* tool result lands
 * in chat. Mirrors vex's UX — full preview of the proposed action +
 * Approve / Reject buttons inline so the operator never leaves the
 * chat to decide. Behind the scenes the buttons hit the same
 * /api/approvals/[id]/approve|reject endpoints the /approvals page
 * uses, so the audit trail and executor dispatch are identical.
 *
 * `<ApprovalActionCardStack>` wraps adjacent cards with a single
 * "Approve all" / "Reject all" header so multi-channel outreach
 * (call+text+email to N people = N+ approvals) doesn't degenerate
 * into N click-throughs the operator might forget. Each card still
 * shows individual state and can be approved/rejected on its own;
 * the bulk buttons just broadcast a signal that pending cards pick
 * up via React context.
 */

export interface ApprovalActionOutput {
  ok: true;
  kind: 'approval_action';
  approvalId: string;
  actionType: string;
  tier: 'T0' | 'T1' | 'T2' | 'T3';
  reviewUrl: string;
  summary: string;
  payload: Record<string, unknown>;
}

export function isApprovalActionOutput(value: unknown): value is ApprovalActionOutput {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v['ok'] === true &&
    v['kind'] === 'approval_action' &&
    typeof v['approvalId'] === 'string' &&
    typeof v['actionType'] === 'string' &&
    typeof v['payload'] === 'object'
  );
}

/**
 * Persistent approval state. The card hydrates from
 * `/api/approvals/[id]` on mount so a thread re-opened after a
 * decision was made shows the actual outcome — not a fresh
 * Approve/Reject prompt that double-fires on click.
 *
 * Sub-state on the `approved` branch tracks executor outcome:
 *   - `sent` — executor wrote `applied_at` (e.g. Twilio MessageSid
 *     stamped on the row); the action successfully dispatched
 *   - `failed` — decision is `approved` but `applied_at` is null;
 *     the executor errored. The user can retry from /approvals.
 *   - `dispatching` — transient while the approve POST is in-flight
 *     (the route awaits dispatch synchronously, so this collapses
 *     into `sent` or `failed` immediately after the API resolves).
 */
type DecisionState =
  | { status: 'loading' }
  | { status: 'pending' }
  | { status: 'submitting' }
  | {
      status: 'approved';
      auto: boolean;
      delivery: 'dispatching' | 'sent' | 'failed';
      appliedAt: Date | null;
    }
  | { status: 'rejected'; decidedAt: Date | null }
  | { status: 'error'; message: string };

interface ApprovalRow {
  id: string;
  decision: 'pending' | 'approved' | 'rejected' | 'auto_approved';
  decidedAt: string | null;
  appliedAt: string | null;
  appliedObjectId: string | null;
  proposedPayload: Record<string, unknown>;
}

type EditableField = 'body' | 'subject' | 'aiInstructions' | 'goalHint';

function rowToState(row: ApprovalRow): DecisionState {
  if (row.decision === 'pending') return { status: 'pending' };
  if (row.decision === 'rejected') {
    return {
      status: 'rejected',
      decidedAt: row.decidedAt ? new Date(row.decidedAt) : null,
    };
  }
  // approved or auto_approved
  return {
    status: 'approved',
    auto: row.decision === 'auto_approved',
    delivery: row.appliedAt ? 'sent' : 'failed',
    appliedAt: row.appliedAt ? new Date(row.appliedAt) : null,
  };
}

const TIER_TONE: Record<string, string> = {
  T0: 'bg-[color:var(--color-muted)]/60 text-[color:var(--color-muted-foreground)]',
  T1: 'bg-blue-100 text-blue-900',
  T2: 'bg-yellow-100 text-yellow-900',
  T3: 'bg-red-100 text-red-900',
};

/**
 * Bulk-action signal broadcast by an enclosing
 * `<ApprovalActionCardStack>`. Each pending card watches `tick` and
 * when it changes, fires its own decide(decision) — keeping each
 * card's individual state machine intact. Cards that have already
 * resolved (approved / rejected / errored) ignore the signal.
 */
interface BulkActionSignal {
  decision: 'approve' | 'reject';
  tick: number;
}
const BulkActionContext = createContext<BulkActionSignal | null>(null);

export function ApprovalActionCard({ output }: { output: ApprovalActionOutput }) {
  const [state, setState] = useState<DecisionState>({ status: 'loading' });
  const stateRef = useRef(state);
  stateRef.current = state;
  // Local mirror of the proposed payload so inline edits (pencil →
  // textarea) render immediately. Seeded from the streamed-in
  // approval output, then refreshed from /api/approvals/[id] on
  // mount so revisiting a thread shows the most recent revision.
  const [payload, setPayload] = useState<Record<string, unknown>>(output.payload);

  // Hydrate the card from the server's view of this approval on mount
  // (and whenever the approvalId changes — happens during streaming
  // when a tool result re-renders with new ids). Without this, a
  // thread re-opened after a decision was made would show stale
  // Approve/Reject buttons and clicking would either re-record a
  // no-op decision (idempotent) or re-fire a duplicate executor
  // dispatch — confusing for the operator either way.
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetch(`/api/approvals/${output.approvalId}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          // Treat 404 / 401 / 5xx as "show buttons" — we can't prove
          // a decision exists, and the worst case is the operator
          // sees a redundant button (clicks are idempotent server-
          // side). Logging keeps real bugs visible.
          if (res.status !== 404) {
            console.warn(
              `[approval-card] hydrate ${output.approvalId} → ${res.status}`,
            );
          }
          setState({ status: 'pending' });
          return;
        }
        const body = (await res.json()) as { row: ApprovalRow };
        setState(rowToState(body.row));
        if (body.row.proposedPayload) {
          setPayload(body.row.proposedPayload);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn('[approval-card] hydrate failed', err);
        setState({ status: 'pending' });
      });
    return () => {
      cancelled = true;
    };
  }, [output.approvalId]);

  const decide = async (decision: 'approve' | 'reject') => {
    setState({ status: 'submitting' });
    try {
      const res = await fetch(`/api/approvals/${output.approvalId}/${decision}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        setState({
          status: 'error',
          message:
            body.message ?? body.error ?? `${decision} failed (${res.status})`,
        });
        return;
      }
      // The approve route awaits dispatchApprovalExecutor, so the
      // server has either stamped applied_at (sent ✓) or left it
      // null (executor failed). Read it back so the card reflects
      // delivery status, not just the decision.
      if (decision === 'approve') {
        try {
          const detail = await fetch(`/api/approvals/${output.approvalId}`, {
            cache: 'no-store',
          });
          if (detail.ok) {
            const body = (await detail.json()) as { row: ApprovalRow };
            setState(rowToState(body.row));
            return;
          }
        } catch {
          // fall through to optimistic state
        }
        setState({
          status: 'approved',
          auto: false,
          delivery: 'dispatching',
          appliedAt: null,
        });
      } else {
        setState({ status: 'rejected', decidedAt: new Date() });
      }
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'unknown error',
      });
    }
  };

  const saveEdit = async (
    field: EditableField,
    value: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    try {
      const res = await fetch(`/api/approvals/${output.approvalId}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, value }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        return {
          ok: false,
          message: body.error ?? `save failed (${res.status})`,
        };
      }
      const body = (await res.json()) as { row: ApprovalRow };
      setPayload(body.row.proposedPayload);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'unknown error',
      };
    }
  };

  /**
   * Translate one field of the approval payload to a target language.
   * Mirrors saveEdit's shape — fires the API, syncs the returned
   * payload, returns ok/error to the EditableField. The audit-trail
   * chip surfaces from payload.translation_audit which the route
   * appends on success.
   */
  const translateField = async (
    field: 'body' | 'subject',
    targetLanguage: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> => {
    try {
      const res = await fetch(
        `/api/approvals/${output.approvalId}/translate-outbound`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field, targetLanguage }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        return {
          ok: false,
          message: body.error ?? `translation failed (${res.status})`,
        };
      }
      const body = (await res.json()) as {
        translated: boolean;
        sourceLanguage: string;
        row: ApprovalRow;
      };
      setPayload(body.row.proposedPayload);
      if (!body.translated) {
        return {
          ok: false,
          message: `text is already in ${targetLanguage} (no translation needed)`,
        };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : 'unknown error',
      };
    }
  };

  const bulk = useContext(BulkActionContext);
  useEffect(() => {
    if (!bulk) return;
    if (stateRef.current.status !== 'pending') return;
    void decide(bulk.decision);
    // decide is stable (defined inline but doesn't read closure state
    // that would change). React 19 dependency lint is happy without
    // wrapping in useCallback because this effect only re-runs on
    // bulk.tick/decision change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bulk?.tick, bulk?.decision]);

  return (
    <div className="rounded-[var(--radius-lg)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-4">
      <header className="mb-3 flex items-center gap-2">
        <span
          className="h-2 w-2 rounded-full"
          style={{ backgroundColor: 'var(--color-warning, #fbbf24)' }}
          aria-hidden
        />
        <span className="font-mono text-sm font-semibold">
          {output.actionType}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${TIER_TONE[output.tier] ?? ''}`}
        >
          {output.tier}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {state.status === 'loading' && (
            <span className="text-xs text-[color:var(--color-muted-foreground)]">
              …
            </span>
          )}
          {state.status === 'pending' || state.status === 'submitting' ? (
            <>
              <button
                type="button"
                onClick={() => decide('approve')}
                disabled={state.status === 'submitting'}
                className="rounded-[var(--radius-md)] bg-emerald-500 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                {state.status === 'submitting' ? '…' : 'Approve'}
              </button>
              <button
                type="button"
                onClick={() => decide('reject')}
                disabled={state.status === 'submitting'}
                className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] px-3 py-1 text-xs font-medium hover:border-[color:var(--color-foreground)] disabled:opacity-50"
              >
                Reject
              </button>
            </>
          ) : null}
          {state.status === 'approved' && (
            <ApprovedBadge state={state} />
          )}
          {state.status === 'rejected' && (
            <span className="rounded-full bg-[color:var(--color-muted)]/60 px-2 py-0.5 text-xs">
              Rejected
              {state.decidedAt && (
                <>
                  {' · '}
                  <time dateTime={state.decidedAt.toISOString()}>
                    {state.decidedAt.toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </time>
                </>
              )}
            </span>
          )}
        </div>
      </header>

      <ActionPreview
        actionType={output.actionType}
        payload={payload}
        summary={output.summary}
        editable={state.status === 'pending'}
        onEdit={saveEdit}
        onTranslate={translateField}
      />

      <OutreachEvidencePanel payload={payload} />

      {state.status === 'error' && (
        <p className="mt-3 text-xs text-red-700">{state.message}</p>
      )}
      {(state.status === 'approved' ||
        state.status === 'rejected' ||
        state.status === 'error') && (
        <p className="mt-3 text-xs text-[color:var(--color-muted-foreground)]">
          <Link href={output.reviewUrl} className="underline">
            View full audit trail
          </Link>
        </p>
      )}
    </div>
  );
}

/**
 * Approved-state pill: distinguishes a successful executor dispatch
 * (`sent`, with timestamp) from a recorded approval whose executor
 * never landed (`failed` — typically a Twilio / Resend outage that
 * raised through the synchronous dispatch path). The operator can
 * retry from /approvals/[id] in the failed case.
 */
function ApprovedBadge({
  state,
}: {
  state: Extract<DecisionState, { status: 'approved' }>;
}) {
  if (state.delivery === 'sent' && state.appliedAt) {
    return (
      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-900">
        ✓ {state.auto ? 'Auto-approved' : 'Approved'} · sent{' '}
        <time dateTime={state.appliedAt.toISOString()}>
          {state.appliedAt.toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </time>
      </span>
    );
  }
  if (state.delivery === 'dispatching') {
    return (
      <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-900">
        ✓ Approved · sending…
      </span>
    );
  }
  // failed
  return (
    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
      ✓ Approved · send failed
    </span>
  );
}

/**
 * Wraps two or more adjacent `<ApprovalActionCard>`s with a header
 * that carries "Approve all (N)" / "Reject all (N)" buttons. Each
 * card retains its own state and approve/reject path; the bulk
 * buttons broadcast a signal via context that pending cards pick up.
 *
 * Use case: chat asks the assistant to "call+text+email Alice, Bob,
 * and Carol about Q2 pricing" — that produces 1 email + 3 SMS + 3
 * calls = 7 separate approvals. Without the stack the operator
 * eyeballs a long list and can easily forget to approve some, leaving
 * outreach partially executed.
 */
export function ApprovalActionCardStack({
  outputs,
}: {
  outputs: ApprovalActionOutput[];
}) {
  const [signal, setSignal] = useState<BulkActionSignal | null>(null);
  const value = useMemo(() => signal, [signal]);
  const trigger = (decision: 'approve' | 'reject') => {
    setSignal((prev) => ({
      decision,
      tick: (prev?.tick ?? 0) + 1,
    }));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-muted)]/40 px-3 py-2 text-xs">
        <span className="font-medium">
          {outputs.length} actions to review
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => trigger('approve')}
            className="rounded-[var(--radius-sm)] bg-emerald-500 px-2.5 py-1 font-semibold text-white hover:bg-emerald-600"
          >
            Approve all ({outputs.length})
          </button>
          <button
            type="button"
            onClick={() => trigger('reject')}
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2.5 py-1 font-medium hover:border-[color:var(--color-foreground)]"
          >
            Reject all
          </button>
        </div>
      </div>
      <BulkActionContext.Provider value={value}>
        {outputs.map((o) => (
          <ApprovalActionCard key={o.approvalId} output={o} />
        ))}
      </BulkActionContext.Provider>
    </div>
  );
}

/** Read a string field from the payload, returning '' for missing/non-string. */
function s(payload: Record<string, unknown>, key: string): string {
  const v = payload[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Per-action-type preview body. Adds new variants here as more
 * propose-* tools land.
 *
 * The four free-text fields (body / subject / aiInstructions /
 * goalHint) are rendered via `<EditableField>` so the operator can
 * tweak language inline before approving — pencil → textarea →
 * save. Each save POSTs to /api/approvals/[id]/edit, updates
 * proposed_payload, and writes a feedback_events row so revisions
 * accumulate as a fine-tuning corpus over time.
 */
type EditCallback = (
  field: EditableField,
  value: string,
) => Promise<{ ok: true } | { ok: false; message: string }>;

function ActionPreview({
  actionType,
  payload,
  summary,
  editable,
  onEdit,
  onTranslate,
}: {
  actionType: string;
  payload: Record<string, unknown>;
  summary: string;
  editable: boolean;
  onEdit: EditCallback;
  onTranslate: (
    field: 'body' | 'subject',
    targetLanguage: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
}) {
  // Pull the latest translation_audit entry per field so EditableField
  // can render the wire/original toggle chip.
  const auditList = Array.isArray(payload['translation_audit'])
    ? (payload['translation_audit'] as TranslationAuditEntry[])
    : [];
  const latestAuditFor = (
    field: 'body' | 'subject',
  ): TranslationAuditEntry | null => {
    for (let i = auditList.length - 1; i >= 0; i -= 1) {
      const e = auditList[i];
      if (e && e.field === field) return e;
    }
    return null;
  };

  if (actionType === 'email.send') {
    const to = (payload['to'] as string[] | undefined) ?? [];
    return (
      <div className="space-y-2 text-sm">
        <p className="text-[color:var(--color-muted-foreground)]">
          to: {to.join(', ')}
        </p>
        <EditableField
          label="Subject"
          value={s(payload, 'subject')}
          editable={editable}
          onSave={(v) => onEdit('subject', v)}
          onTranslate={(lang) => onTranslate('subject', lang)}
          translationAudit={latestAuditFor('subject')}
          variant="single-line"
          renderClassName="font-semibold"
        />
        <EditableField
          label="Body"
          value={s(payload, 'body')}
          editable={editable}
          onSave={(v) => onEdit('body', v)}
          onTranslate={(lang) => onTranslate('body', lang)}
          translationAudit={latestAuditFor('body')}
          variant="multi-line"
        />
      </div>
    );
  }
  if (actionType === 'sms.send' || actionType === 'whatsapp.send') {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-[color:var(--color-muted-foreground)]">
          to: {s(payload, 'to')}
        </p>
        <EditableField
          label="Message"
          value={s(payload, 'body')}
          editable={editable}
          onSave={(v) => onEdit('body', v)}
          onTranslate={(lang) => onTranslate('body', lang)}
          translationAudit={latestAuditFor('body')}
          variant="multi-line"
        />
      </div>
    );
  }
  if (actionType === 'whatsapp.send_template') {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-[color:var(--color-muted-foreground)]">
          to: {s(payload, 'to')}
        </p>
        <p className="text-xs">
          template: <span className="font-mono">{s(payload, 'contentSid')}</span>
          {s(payload, 'templateName') && <> ({s(payload, 'templateName')})</>}
        </p>
      </div>
    );
  }
  if (actionType === 'outbound_call') {
    const aiMode = payload['aiMode'] === true;
    return (
      <div className="space-y-2 text-sm">
        <p>
          <span className="text-[color:var(--color-muted-foreground)]">
            Calling:
          </span>{' '}
          <span className="font-mono">{s(payload, 'toNumber')}</span>
          {aiMode && (
            <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-900">
              AI mode
            </span>
          )}
        </p>
        <EditableField
          label="Goal"
          value={s(payload, 'goalHint')}
          editable={editable}
          onSave={(v) => onEdit('goalHint', v)}
          variant="single-line"
          hideWhenEmpty
        />
        {aiMode && (
          <EditableField
            label="AI instructions"
            value={s(payload, 'aiInstructions')}
            editable={editable}
            onSave={(v) => onEdit('aiInstructions', v)}
            variant="multi-line"
            collapsedByDefault
          />
        )}
      </div>
    );
  }
  if (actionType === 'crm.create_company') {
    return (
      <div className="space-y-1 text-sm">
        <p>
          <span className="text-[color:var(--color-muted-foreground)]">Legal name:</span>{' '}
          <span className="font-medium">{s(payload, 'legalName')}</span>
        </p>
        {s(payload, 'domain') && (
          <p>
            <span className="text-[color:var(--color-muted-foreground)]">Domain:</span>{' '}
            {s(payload, 'domain')}
          </p>
        )}
        {s(payload, 'industry') && (
          <p>
            <span className="text-[color:var(--color-muted-foreground)]">Industry:</span>{' '}
            {s(payload, 'industry')}
          </p>
        )}
        <p className="text-xs text-[color:var(--color-muted-foreground)]">
          {s(payload, 'rationale')}
        </p>
      </div>
    );
  }
  if (actionType === 'crm.create_contact') {
    const orgs =
      (payload['orgs'] as
        | Array<{ orgId?: string; knownEntitySlug?: string; role?: string }>
        | undefined) ?? [];
    const emails = (payload['emails'] as string[] | undefined) ?? [];
    const phones = (payload['phones'] as string[] | undefined) ?? [];
    return (
      <div className="space-y-1 text-sm">
        <p className="font-medium">{s(payload, 'fullName')}</p>
        {s(payload, 'title') && (
          <p className="text-xs">{s(payload, 'title')}</p>
        )}
        {emails.length > 0 && (
          <p className="text-xs">{emails.join(', ')}</p>
        )}
        {phones.length > 0 && (
          <p className="text-xs">{phones.join(', ')}</p>
        )}
        {orgs.length > 0 && (
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            Linking to{' '}
            {orgs.map((o, i) => (
              <span key={i}>
                {i > 0 && ', '}
                {o.knownEntitySlug ? (
                  <Link
                    href={`/entities/${o.knownEntitySlug}`}
                    className="font-mono underline hover:text-[color:var(--color-foreground)]"
                  >
                    {o.knownEntitySlug}
                  </Link>
                ) : o.orgId ? (
                  <span className="font-mono">{o.orgId.slice(0, 12)}…</span>
                ) : (
                  <span>(unspecified)</span>
                )}
              </span>
            ))}
            .{' '}
            {s(payload, 'rationale')}
          </p>
        )}
      </div>
    );
  }
  if (actionType === 'crm.create_deal') {
    const dealRef = s(payload, 'dealRef');
    return (
      <div className="space-y-1 text-sm">
        <p className="font-mono font-semibold">{dealRef}</p>
        <p className="text-xs">
          {s(payload, 'product').toUpperCase()} ·{' '}
          {Number(payload['volumeUsg'] ?? 0).toLocaleString()}{' '}
          {s(payload, 'volumeUnit')} ·{' '}
          {s(payload, 'incoterm').toUpperCase()}
        </p>
        <p className="text-xs">
          Pricing: {s(payload, 'pricingBasis')} ·{' '}
          Payment: {s(payload, 'paymentTerms')}
        </p>
        {s(payload, 'destinationPort') && (
          <p className="text-xs">
            Destination: {s(payload, 'destinationPort')}
          </p>
        )}
        <p className="text-xs text-[color:var(--color-muted-foreground)]">
          {s(payload, 'rationale')}
        </p>
      </div>
    );
  }
  if (actionType === 'deal.status_change') {
    const dealId = s(payload, 'deal_id');
    return (
      <div className="space-y-1 text-sm">
        <p>
          <span className="text-[color:var(--color-muted-foreground)]">Deal:</span>{' '}
          <Link
            href={`/deals/${dealId}`}
            className="font-mono underline hover:text-[color:var(--color-foreground)]"
          >
            {dealId.slice(0, 12)}
          </Link>
        </p>
        <p>
          <span className="text-[color:var(--color-muted-foreground)]">→ status:</span>{' '}
          <span className="font-medium">{s(payload, 'to_status')}</span>
        </p>
        <p className="text-xs text-[color:var(--color-muted-foreground)]">
          {s(payload, 'rationale')}
        </p>
      </div>
    );
  }
  if (actionType === 'deal.milestone') {
    const dealId = s(payload, 'dealId');
    return (
      <div className="space-y-1 text-sm">
        <p>
          <span className="text-[color:var(--color-muted-foreground)]">Deal:</span>{' '}
          <Link
            href={`/deals/${dealId}`}
            className="font-mono underline hover:text-[color:var(--color-foreground)]"
          >
            {dealId.slice(0, 12)}
          </Link>
        </p>
        <p>
          <span className="text-[color:var(--color-muted-foreground)]">Milestone:</span>{' '}
          <span className="font-medium">{s(payload, 'milestone')}</span>
        </p>
        {s(payload, 'note') && (
          <p className="text-xs">{s(payload, 'note')}</p>
        )}
      </div>
    );
  }
  if (actionType === 'lead.close') {
    const leadId = s(payload, 'leadId');
    return (
      <div className="space-y-1 text-sm">
        <p>
          <span className="text-[color:var(--color-muted-foreground)]">Lead:</span>{' '}
          <Link
            href={`/leads/${leadId}`}
            className="font-mono underline hover:text-[color:var(--color-foreground)]"
          >
            {leadId.slice(0, 12)}
          </Link>
        </p>
        <p>
          Outcome:{' '}
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
              payload['outcome'] === 'won'
                ? 'bg-green-100 text-green-900'
                : 'bg-red-100 text-red-900'
            }`}
          >
            {s(payload, 'outcome')}
          </span>
        </p>
        <p className="text-xs">{s(payload, 'reason')}</p>
      </div>
    );
  }
  if (actionType === 'follow_up.schedule') {
    return (
      <div className="space-y-1 text-sm">
        <p className="font-medium">{s(payload, 'title')}</p>
        <p className="text-xs">
          Due:{' '}
          <time dateTime={s(payload, 'dueAt')}>
            {new Date(s(payload, 'dueAt')).toLocaleString()}
          </time>
        </p>
        {s(payload, 'note') && (
          <p className="text-xs text-[color:var(--color-muted-foreground)]">
            {s(payload, 'note')}
          </p>
        )}
      </div>
    );
  }
  if (actionType === 'sanctions.screen') {
    const orgId = s(payload, 'organizationId');
    // organizationId here is a known_entity slug (the sanctions tool
    // operates on rolodex entities), not a CRM ULID. Treat the value
    // as a slug and link to the entity profile.
    return (
      <div className="space-y-1 text-sm">
        <p>
          <span className="text-[color:var(--color-muted-foreground)]">Org:</span>{' '}
          <Link
            href={`/entities/${orgId}`}
            className="font-mono underline hover:text-[color:var(--color-foreground)]"
          >
            {orgId.length > 30 ? `${orgId.slice(0, 30)}…` : orgId}
          </Link>
        </p>
        <p className="text-xs text-[color:var(--color-muted-foreground)]">
          {s(payload, 'rationale')}
        </p>
      </div>
    );
  }
  // Generic fallback — show summary + raw payload (collapsed).
  return (
    <div className="space-y-2 text-sm">
      <p>{summary}</p>
      <details className="text-xs">
        <summary className="cursor-pointer text-[color:var(--color-muted-foreground)]">
          Show payload
        </summary>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono">
          {JSON.stringify(payload, null, 2)}
        </pre>
      </details>
    </div>
  );
}

/**
 * Per-action-kind evidence panel — renders ONLY when the descriptor
 * carries recommendation-pipeline output (`evidenceJson`,
 * `mlEvidence`, `riskWarnings`, etc.). Manual operator-driven
 * proposals leave these blank and the panel is silent.
 *
 * The panel is the audit-trail surface for "Why this outreach?" —
 * model version, evidence items with confidence, source entity /
 * signal / opportunity, and any risk warnings the pipeline flagged.
 * `doNotMention` is shown so the operator can verify the body
 * doesn't accidentally surface internal-only context (ML scores,
 * pipeline tags, etc.).
 */
function OutreachEvidencePanel({ payload }: { payload: Record<string, unknown> }) {
  const evidenceJson = payload['evidenceJson'];
  const mlEvidence = payload['mlEvidence'] as
    | {
        modelVersion?: string;
        totalScore?: number;
        items?: Array<{
          kind?: string;
          sourceId?: string;
          confidence?: number;
          summary?: string;
        }>;
      }
    | undefined;
  const sourceEntitySlug = s(payload, 'sourceEntitySlug');
  const sourceSignalId = s(payload, 'sourceSignalId');
  const sourceOpportunityId = s(payload, 'sourceOpportunityId');
  const riskWarnings = (payload['riskWarnings'] as string[] | undefined) ?? [];
  const doNotMention = (payload['doNotMention'] as string[] | undefined) ?? [];

  const hasAny =
    Boolean(mlEvidence) ||
    Boolean(evidenceJson) ||
    Boolean(sourceEntitySlug) ||
    Boolean(sourceSignalId) ||
    Boolean(sourceOpportunityId) ||
    riskWarnings.length > 0 ||
    doNotMention.length > 0;
  if (!hasAny) return null;

  return (
    <details className="mt-4 rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] bg-[color:var(--color-muted)]/30 px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium">
        Why this outreach?{' '}
        <span className="text-[color:var(--color-muted-foreground)]">
          (internal — not shown to recipient)
        </span>
      </summary>
      <div className="mt-3 space-y-3">
        {(sourceEntitySlug || sourceSignalId || sourceOpportunityId) && (
          <div className="space-y-1">
            {sourceEntitySlug && (
              <p>
                <span className="text-[color:var(--color-muted-foreground)]">
                  Entity:
                </span>{' '}
                <span className="font-mono">{sourceEntitySlug}</span>
              </p>
            )}
            {sourceSignalId && (
              <p>
                <span className="text-[color:var(--color-muted-foreground)]">
                  Signal:
                </span>{' '}
                <span className="font-mono">{sourceSignalId}</span>
              </p>
            )}
            {sourceOpportunityId && (
              <p>
                <span className="text-[color:var(--color-muted-foreground)]">
                  Opportunity:
                </span>{' '}
                <span className="font-mono">{sourceOpportunityId}</span>
              </p>
            )}
          </div>
        )}

        {mlEvidence && Array.isArray(mlEvidence.items) && (
          <div>
            <p className="mb-1 text-[color:var(--color-muted-foreground)]">
              Model {mlEvidence.modelVersion ?? '?'}
              {typeof mlEvidence.totalScore === 'number' && (
                <> · score {mlEvidence.totalScore}/100</>
              )}
            </p>
            <ul className="space-y-1">
              {mlEvidence.items.map((item, i) => (
                <li
                  key={`${item.sourceId ?? 'ev'}-${i}`}
                  className="flex items-start gap-2"
                >
                  <span className="rounded-full bg-[color:var(--color-muted)] px-1.5 py-0.5 text-[10px] font-mono">
                    {item.kind ?? 'evidence'}
                  </span>
                  <span className="flex-1">
                    {item.summary ?? '(no summary)'}
                    {typeof item.confidence === 'number' && (
                      <span className="ml-1 text-[color:var(--color-muted-foreground)]">
                        · {Math.round(item.confidence * 100)}% conf
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {riskWarnings.length > 0 && (
          <div>
            <p className="mb-1 font-medium text-red-700">Risk warnings</p>
            <ul className="list-disc space-y-0.5 pl-4 text-red-700">
              {riskWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        {doNotMention.length > 0 && (
          <div>
            <p className="mb-1 font-medium">
              Do NOT mention in the outbound copy:
            </p>
            <ul className="list-disc space-y-0.5 pl-4">
              {doNotMention.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          </div>
        )}

        {evidenceJson != null && typeof evidenceJson === 'object' && (
          <details>
            <summary className="cursor-pointer text-[color:var(--color-muted-foreground)]">
              Raw evidence pack
            </summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-sm)] bg-[color:var(--color-muted)]/40 p-2 font-mono">
              {JSON.stringify(evidenceJson, null, 2)}
            </pre>
          </details>
        )}
      </div>
    </details>
  );
}

/**
 * Inline editable field on an approval preview. Click the pencil to
 * swap the rendered value for a textarea + Save / Cancel; on save,
 * `onSave(value)` POSTs to `/api/approvals/[id]/edit` and the parent
 * card mirrors the new payload locally so the rendered preview
 * matches what's in the DB.
 *
 * Variants:
 *   - `single-line` — short fields (subject, goalHint), uses an
 *     <input> in edit mode
 *   - `multi-line` — long fields (body, aiInstructions), uses a
 *     <textarea> sized to content
 *
 * `editable={false}` hides the pencil entirely — used when the
 * approval is already approved / rejected / applied so post-decision
 * rewrites don't silently happen.
 *
 * `collapsedByDefault` wraps the whole field in <details> so long
 * AI-instruction blobs don't dominate the card. Pencil sits in the
 * summary row; clicking pencil expands and switches to edit mode in
 * one motion.
 */
/**
 * Translation audit entry stored on the approval payload by
 * translateApprovalField. The latest entry per (field) is what the
 * card surfaces — earlier entries are kept for audit but not shown.
 */
interface TranslationAuditEntry {
  field: 'body' | 'subject';
  original_text: string;
  translation: string;
  source_language: string;
  target_language: string;
  translated_at: string;
}

function EditableField({
  label,
  value,
  editable,
  onSave,
  onTranslate,
  translationAudit,
  variant,
  hideWhenEmpty,
  renderClassName,
  collapsedByDefault,
}: {
  label: string;
  value: string;
  editable: boolean;
  onSave: (
    v: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** Optional outbound-translation handler. When provided, an
   *  inline "Translate to <lang>" affordance renders alongside the
   *  pencil edit button. Operator types the target language code,
   *  the call replaces this field's value with the translation
   *  (preserving the original on the payload's translation_audit
   *  for the audit-trail chip). */
  onTranslate?: (
    targetLanguage: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** When this field has a most-recent translation entry on the
   *  payload's translation_audit, the chip surfaces the original
   *  with a click-to-show toggle similar to inbound's
   *  TranslatableText. */
  translationAudit?: TranslationAuditEntry | null;
  variant: 'single-line' | 'multi-line';
  hideWhenEmpty?: boolean;
  renderClassName?: string;
  collapsedByDefault?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [translatePopoverOpen, setTranslatePopoverOpen] = useState(false);
  const [translateTarget, setTranslateTarget] = useState('');
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);

  // Reset draft when the underlying value changes from outside (e.g.
  // hydrate fetch resolved with a more recent revision than the
  // streamed-in initial payload).
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  if (!value && hideWhenEmpty && !editing) return null;

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    const result = await onSave(draft);
    setSaving(false);
    if (result.ok) {
      setEditing(false);
    } else {
      setError(result.message);
    }
  };

  const handleCancel = () => {
    setDraft(value);
    setEditing(false);
    setError(null);
  };

  if (editing) {
    return (
      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-wide text-[color:var(--color-muted-foreground)]">
          {label}
        </p>
        {variant === 'single-line' ? (
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            className="w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1 text-sm focus:border-[color:var(--color-foreground)] focus:outline-none disabled:opacity-50"
          />
        ) : (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            rows={Math.max(3, Math.min(20, draft.split('\n').length + 1))}
            className="w-full resize-y rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 font-sans text-sm leading-relaxed focus:border-[color:var(--color-foreground)] focus:outline-none disabled:opacity-50"
          />
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || draft === value}
            className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-2 py-0.5 text-xs font-medium text-[color:var(--color-background)] disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={handleCancel}
            disabled={saving}
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-2 py-0.5 text-xs disabled:opacity-50"
          >
            Cancel
          </button>
          {error && <span className="text-xs text-red-700">{error}</span>}
        </div>
      </div>
    );
  }

  const pencil = editable && (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={`Edit ${label.toLowerCase()}`}
      aria-label={`Edit ${label.toLowerCase()}`}
      className="text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
    >
      {/* Inline pencil glyph keeps the bundle small (no icon-library
       *   dep). Unicode pencil PNG-equivalent is U+270E. */}
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25a1.75 1.75 0 0 1 .445-.758l8.61-8.61Z" />
      </svg>
    </button>
  );

  const handleTranslate = async () => {
    if (!onTranslate) return;
    const target = translateTarget.trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(target)) {
      setTranslateError('expected 2-letter ISO code (e.g. ja, fr, ko)');
      return;
    }
    setTranslating(true);
    setTranslateError(null);
    const result = await onTranslate(target);
    setTranslating(false);
    if (result.ok) {
      setTranslatePopoverOpen(false);
      setTranslateTarget('');
    } else {
      setTranslateError(result.message);
    }
  };

  const translateAffordance = editable && onTranslate && (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setTranslatePopoverOpen((v) => !v)}
        title="Translate to target language for the wire"
        aria-label="Translate"
        className="text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-foreground)]"
      >
        Translate
      </button>
      {translatePopoverOpen && (
        <div className="absolute right-0 top-5 z-10 flex items-center gap-1 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-1 shadow-md">
          <input
            type="text"
            value={translateTarget}
            onChange={(e) => setTranslateTarget(e.target.value)}
            placeholder="ja"
            maxLength={2}
            disabled={translating}
            className="w-12 rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-1 py-0.5 text-xs uppercase"
          />
          <button
            type="button"
            onClick={handleTranslate}
            disabled={translating || translateTarget.trim().length !== 2}
            className="rounded-[var(--radius-sm)] bg-[color:var(--color-foreground)] px-2 py-0.5 text-xs font-medium text-[color:var(--color-background)] disabled:opacity-50"
          >
            {translating ? '...' : 'Go'}
          </button>
          <button
            type="button"
            onClick={() => {
              setTranslatePopoverOpen(false);
              setTranslateTarget('');
              setTranslateError(null);
            }}
            disabled={translating}
            className="rounded-[var(--radius-sm)] border border-[color:var(--color-border)] px-1 py-0.5 text-xs"
          >
            ×
          </button>
        </div>
      )}
      {translateError && (
        <span className="ml-2 text-[10px] text-red-700">{translateError}</span>
      )}
    </div>
  );

  // Translation chip — when this field's most-recent audit entry is
  // present, surface the wire/original toggle. Mirrors inbound's
  // TranslatableText UX so operator gets the same mental model on
  // both ends of a non-English thread.
  const translationChip = translationAudit && translationAudit.field === label.toLowerCase() && (
    <button
      type="button"
      onClick={() => setShowOriginal((v) => !v)}
      title={
        showOriginal
          ? `Show wire copy (${translationAudit.target_language})`
          : `Show original (${translationAudit.source_language})`
      }
      className="inline-flex items-center gap-1 rounded-full border border-[color:var(--color-border)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[color:var(--color-muted-foreground)] hover:border-[color:var(--color-foreground)] hover:text-[color:var(--color-foreground)]"
    >
      {showOriginal
        ? `Original (${translationAudit.source_language}) — show wire`
        : `Translated to ${translationAudit.target_language} — show original`}
    </button>
  );

  // What gets rendered: when toggled to "show original", display the
  // operator's pre-translation text from the audit row; otherwise
  // the field's current value (which IS the translation post-call).
  const displayValue =
    showOriginal && translationAudit ? translationAudit.original_text : value;

  if (collapsedByDefault) {
    return (
      <details className="text-xs">
        <summary className="flex cursor-pointer items-center gap-2 text-[color:var(--color-muted-foreground)]">
          <span>{label}</span>
          {pencil}
          {translateAffordance}
        </summary>
        {translationChip && <div className="mt-1">{translationChip}</div>}
        <pre className={`mt-1 whitespace-pre-wrap break-words font-sans ${renderClassName ?? ''}`}>
          {displayValue}
        </pre>
      </details>
    );
  }

  if (variant === 'single-line') {
    return (
      <div className="space-y-1">
        <div className="flex items-baseline gap-2">
          <p className={renderClassName ?? ''}>{displayValue}</p>
          {pencil}
          {translateAffordance}
        </div>
        {translationChip}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {translationChip}
      <div className="flex items-start gap-2">
        <pre
          className={`flex-1 whitespace-pre-wrap break-words font-sans text-sm leading-relaxed ${renderClassName ?? ''}`}
        >
          {displayValue}
        </pre>
        <span className="mt-1 flex shrink-0 flex-col items-end gap-1">
          {pencil}
          {translateAffordance}
        </span>
      </div>
    </div>
  );
}
