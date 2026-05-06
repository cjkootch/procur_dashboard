import { ulid } from 'ulid';

/**
 * ULID generator. Vex used `createId()` from @vex/domain — same shape
 * (Crockford-base32, 26 chars, lexicographically sortable by time).
 * Used as the primary key for Phase 1 vex-imported tables (organizations,
 * contacts, agent_runs, approvals, fuel_deals, etc.) — those tables use
 * text PKs not procur's uuid default.
 */
export function createId(): string {
  return ulid();
}

/** Validate a string is a ULID. Mirrors vex's @vex/domain isUlid. */
export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
