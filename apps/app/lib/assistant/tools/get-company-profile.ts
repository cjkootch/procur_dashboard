import 'server-only';
import { z } from 'zod';
import { defineTool } from '@procur/ai';
import { db, companies } from '@procur/db';
import { eq } from 'drizzle-orm';

const input = z.object({});

export const getCompanyProfileTool = defineTool({
  name: 'get_company_profile',
  description:
    "Return the current company's profile: name, country, industry, declared capabilities, preferred jurisdictions and categories, and target contract size. Useful for answering 'what do we do?' or 'where do we bid?' style questions.",
  kind: 'read',
  schema: input,
  handler: async (ctx) => {
    const row = await db.query.companies.findFirst({
      where: eq(companies.id, ctx.companyId),
      columns: {
        name: true,
        country: true,
        industry: true,
        yearFounded: true,
        employeeCount: true,
        annualRevenue: true,
        capabilities: true,
        preferredJurisdictions: true,
        preferredCategories: true,
        targetContractSizeMin: true,
        targetContractSizeMax: true,
        planTier: true,
      },
    });
    if (!row) return { error: 'company_not_found' };
    return row;
  },
});
