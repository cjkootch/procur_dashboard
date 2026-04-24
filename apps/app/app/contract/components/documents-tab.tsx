import type { Contract } from '@procur/db';
import { updateContractAction } from '../actions';

/**
 * Documents tab — placeholder for Sprint B's full document store.
 *
 * Current schema only stores two URL strings (contract doc + PWS/SOW).
 * Sprint B introduces a `contract_documents` table with R2 uploads,
 * type / tags / status / uploader, and a proper linked + suggested
 * documents workflow. This tab surfaces what we do have so the
 * navigation is complete, and signals what's coming.
 */
export function DocumentsTab({ contract }: { contract: Contract }) {
  return (
    <div className="space-y-4">
      <section className="rounded-[var(--radius-md)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5">
        <h2 className="mb-1 text-sm font-semibold">Linked documents</h2>
        <p className="mb-4 text-xs text-[color:var(--color-muted-foreground)]">
          Primary contract document and statement of work. Full document library
          (uploads, types, tags, review status, audit trail) ships in the next
          Contract release.
        </p>
        <form action={updateContractAction} className="grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="id" value={contract.id} />

          {/* Preserve all the other fields so updateContractAction doesn't blank them. */}
          <input type="hidden" name="awardTitle" value={contract.awardTitle} />
          <input type="hidden" name="tier" value={contract.tier} />
          <input type="hidden" name="status" value={contract.status} />
          <input type="hidden" name="contractNumber" value={contract.contractNumber ?? ''} />
          <input
            type="hidden"
            name="parentContractNumber"
            value={contract.parentContractNumber ?? ''}
          />
          <input type="hidden" name="taskOrderNumber" value={contract.taskOrderNumber ?? ''} />
          <input type="hidden" name="subcontractNumber" value={contract.subcontractNumber ?? ''} />
          <input type="hidden" name="awardingAgency" value={contract.awardingAgency ?? ''} />
          <input type="hidden" name="primeContractor" value={contract.primeContractor ?? ''} />
          <input type="hidden" name="awardDate" value={contract.awardDate ?? ''} />
          <input type="hidden" name="startDate" value={contract.startDate ?? ''} />
          <input type="hidden" name="endDate" value={contract.endDate ?? ''} />
          <input type="hidden" name="totalValue" value={contract.totalValue ?? ''} />
          <input type="hidden" name="currency" value={contract.currency ?? 'USD'} />
          <input type="hidden" name="notes" value={contract.notes ?? ''} />

          <label>
            <LabelText>Contract document URL</LabelText>
            <input
              name="contractDocumentUrl"
              type="url"
              defaultValue={contract.contractDocumentUrl ?? ''}
              placeholder="https://…"
              className={INPUT_CLS}
            />
          </label>
          <label>
            <LabelText>PWS / SOW URL</LabelText>
            <input
              name="pwsSowDocumentUrl"
              type="url"
              defaultValue={contract.pwsSowDocumentUrl ?? ''}
              placeholder="https://…"
              className={INPUT_CLS}
            />
          </label>
          <div className="sm:col-span-2 flex justify-end">
            <button
              type="submit"
              className="rounded-[var(--radius-md)] bg-[color:var(--color-foreground)] px-4 py-2 text-sm font-medium text-[color:var(--color-background)]"
            >
              Save document links
            </button>
          </div>
        </form>
      </section>

      <section className="rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border)] p-5 text-sm text-[color:var(--color-muted-foreground)]">
        <p className="font-medium text-[color:var(--color-foreground)]">Coming soon</p>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>Upload any number of contract documents (award, mods, amendments, CDRLs)</li>
          <li>Document types + tags + review status per file</li>
          <li>Uploader attribution and audit trail</li>
          <li>AI-detected modifications with per-field approve / reject</li>
        </ul>
      </section>
    </div>
  );
}

const INPUT_CLS =
  'mt-1 w-full rounded-[var(--radius-sm)] border border-[color:var(--color-border)] bg-[color:var(--color-background)] px-2 py-1.5 text-sm';

function LabelText({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] uppercase tracking-wider text-[color:var(--color-muted-foreground)]">
      {children}
    </span>
  );
}
