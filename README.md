# Procur

AI-native government tender intelligence and bid generation for emerging markets (Caribbean, Latin America, Africa).

## Repository layout

```
apps/
  discover/    # discover.procur.app — public tender aggregation
  app/         # app.procur.app — authenticated product (Capture, Proposal, Pricer, Contract)
  marketing/   # procur.app — landing and pricing
  admin/       # admin.procur.app — internal console
services/
  scrapers/    # Trigger.dev project — portal scrapers
  ai-pipeline/ # Trigger.dev project — AI enrichment jobs
  email-digest/# Trigger.dev project — daily/weekly digests
packages/
  config/      # shared ESLint, TS, Tailwind configs
  db/          # Drizzle schema + client
  auth/        # Clerk wrappers
  ai/          # AI abstractions (Anthropic/OpenAI)
  scrapers-core/ # base scraper class + shared scraping utilities
  ui/          # shadcn components + Procur design system
  email-templates/ # React Email templates
  types/       # shared types
  analytics/   # PostHog wrapper
  utils/       # shared utilities
docs/          # architecture, data model, scrapers, AI prompts
```

## Prerequisites

- Node >= 20
- pnpm >= 9

## Getting started

```bash
pnpm install
cp .env.example .env.local  # fill in credentials
pnpm dev                    # runs all apps in parallel
```

| App       | URL                    |
| --------- | ---------------------- |
| marketing | http://localhost:3000  |
| discover  | http://localhost:3001  |
| app       | http://localhost:3002  |
| admin     | http://localhost:3003  |

## Scripts

- `pnpm dev` — run all apps
- `pnpm build` — build all apps
- `pnpm lint` — lint all packages
- `pnpm type-check` — TypeScript check
- `pnpm db:generate` — generate Drizzle migrations
- `pnpm db:push` — push schema to database
- `pnpm db:studio` — Drizzle Studio

## Phases

1. **Foundation** (days 1-3) — monorepo, auth, database, deployment
2. **Discover** (days 4-14) — scrapers, AI enrichment, public browse, digests
3. **Capture** (weeks 3-4) — pipeline, pursuits, tasks, Stripe
4. **Proposal** (weeks 5-9) — tender shredding, AI drafting, compliance matrix, Word export
5. **Pricer** (weeks 10-12) — cost estimation, labor categories, indirect rates
6. **Contract** (weeks 12-14) — inventory, obligations
7. **Procur Assistant** (week 16+) — cross-product AI agent
