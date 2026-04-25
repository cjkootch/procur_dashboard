import { eq } from 'drizzle-orm';
import { companies, db, users } from '@procur/db';
import { authenticateWordAddinRequest, jsonResponse, unauthorized } from '../_lib';

export const runtime = 'nodejs';

/**
 * POST /api/word-addin/auth
 *
 * Verifies a token and returns the bound user + company. The taskpane
 * calls this once on first paste so it can show "Signed in as <name> ·
 * <company>" and also catches revoked / mistyped tokens before any
 * other API call.
 */
export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateWordAddinRequest(req);
  if (!auth) return unauthorized();

  const [row] = await db
    .select({
      userId: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      companyId: companies.id,
      companyName: companies.name,
    })
    .from(users)
    .innerJoin(companies, eq(companies.id, users.companyId))
    .where(eq(users.id, auth.userId))
    .limit(1);

  if (!row) return unauthorized();

  return jsonResponse({
    user: {
      id: row.userId,
      firstName: row.firstName,
      lastName: row.lastName,
      email: row.email,
    },
    company: {
      id: row.companyId,
      name: row.companyName,
    },
  });
}
