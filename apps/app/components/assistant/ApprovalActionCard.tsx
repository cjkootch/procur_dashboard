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
}

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
        payload={output.payload}
        summary={output.summary}
      />

      <OutreachEvidencePanel payload={output.payload} />

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
 */
function ActionPreview({
  actionType,
  payload,
  summary,
}: {
  actionType: string;
  payload: Record<string, unknown>;
  summary: string;
}) {
  if (actionType === 'email.send') {
    const to = (payload['to'] as string[] | undefined) ?? [];
    return (
      <div className="space-y-2 text-sm">
        <p className="text-[color:var(--color-muted-foreground)]">
          to: {to.join(', ')}
        </p>
        <p className="font-semibold">{s(payload, 'subject')}</p>
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
          {s(payload, 'body')}
        </pre>
      </div>
    );
  }
  if (actionType === 'sms.send' || actionType === 'whatsapp.send') {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-[color:var(--color-muted-foreground)]">
          to: {s(payload, 'to')}
        </p>
        <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed">
          {s(payload, 'body')}
        </pre>
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
        {s(payload, 'goalHint') && (
          <p>
            <span className="text-[color:var(--color-muted-foreground)]">Goal:</span>{' '}
            {s(payload, 'goalHint')}
          </p>
        )}
        {aiMode && s(payload, 'aiInstructions') && (
          <details className="text-xs">
            <summary className="cursor-pointer text-[color:var(--color-muted-foreground)]">
              AI instructions
            </summary>
            <pre className="mt-1 whitespace-pre-wrap break-words font-sans">
              {s(payload, 'aiInstructions')}
            </pre>
          </details>
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
    const orgs = (payload['orgs'] as Array<{ orgId: string }> | undefined) ?? [];
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
        <p className="text-xs text-[color:var(--color-muted-foreground)]">
          Linking to {orgs.length} org{orgs.length === 1 ? '' : 's'}.{' '}
          {s(payload, 'rationale')}
        </p>
      </div>
    );
  }
  if (actionType === 'crm.create_deal') {
    return (
      <div className="space-y-1 text-sm">
        <p className="font-mono font-semibold">{s(payload, 'dealRef')}</p>
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
    return (
      <div className="space-y-1 text-sm">
        <p>
          <span className="text-[color:var(--color-muted-foreground)]">Deal:</span>{' '}
          <span className="font-mono">{s(payload, 'deal_id').slice(0, 12)}</span>
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
    return (
      <div className="space-y-1 text-sm">
        <p>
          <span className="text-[color:var(--color-muted-foreground)]">Deal:</span>{' '}
          <span className="font-mono">{s(payload, 'dealId').slice(0, 12)}</span>
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
    return (
      <div className="space-y-1 text-sm">
        <p>
          <span className="text-[color:var(--color-muted-foreground)]">Lead:</span>{' '}
          <span className="font-mono">{s(payload, 'leadId').slice(0, 12)}</span>
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
    return (
      <div className="space-y-1 text-sm">
        <p>
          <span className="text-[color:var(--color-muted-foreground)]">Org:</span>{' '}
          <span className="font-mono">
            {s(payload, 'organizationId').slice(0, 12)}
          </span>
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
