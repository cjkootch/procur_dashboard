import 'server-only';
import { asc, eq } from 'drizzle-orm';
import {
  db,
  pursuitTeamMembers,
  type PursuitTeamMember,
  type TeamRole,
  type TeamingStatus,
} from '@procur/db';

export const TEAM_ROLE_LABEL: Record<TeamRole, string> = {
  prime: 'Prime',
  subcontractor: 'Subcontractor',
  joint_venture: 'JV partner',
  mentor: 'Mentor',
  consultant: 'Consultant',
};

export const TEAMING_STATUS_LABEL: Record<TeamingStatus, string> = {
  engaging: 'Engaging',
  nda_signed: 'NDA signed',
  teaming_agreement: 'Teaming agreement',
  executed: 'Executed',
  declined: 'Declined',
};

export async function listTeamMembersForPursuit(pursuitId: string): Promise<PursuitTeamMember[]> {
  return db
    .select()
    .from(pursuitTeamMembers)
    .where(eq(pursuitTeamMembers.pursuitId, pursuitId))
    .orderBy(asc(pursuitTeamMembers.sortOrder), asc(pursuitTeamMembers.createdAt));
}

export type TeamSummary = {
  totalCount: number;
  totalAllocationPct: number;
  hasPrime: boolean;
  signedCount: number;
};

export function summarizeTeam(members: PursuitTeamMember[]): TeamSummary {
  let total = 0;
  let signed = 0;
  let hasPrime = false;
  for (const m of members) {
    if (m.allocationPct != null) total += Number(m.allocationPct);
    if (m.role === 'prime') hasPrime = true;
    if (m.status === 'executed' || m.status === 'teaming_agreement') signed += 1;
  }
  return {
    totalCount: members.length,
    totalAllocationPct: total,
    hasPrime,
    signedCount: signed,
  };
}
