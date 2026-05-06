# Dockerfile for procur-voice-bridge — deployed to Fly per
# docs/vex-into-procur-merge-brief.md Phase 7.5.
#
# pnpm workspace builds need the full monorepo context to resolve
# workspace deps (@procur/ai + @procur/db). We copy the whole repo,
# install with --frozen-lockfile, and run from services/voice-bridge.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /repo

# Copy lockfile + workspace manifests for cached install layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/ai/package.json ./packages/ai/
COPY packages/db/package.json ./packages/db/
COPY packages/config/package.json ./packages/config/
COPY services/voice-bridge/package.json ./services/voice-bridge/

RUN pnpm install --frozen-lockfile --filter @procur/voice-bridge...

# Copy the rest of the source.
COPY . .

# Service runs via tsx (TypeScript directly; no separate build step).
WORKDIR /repo/services/voice-bridge
EXPOSE 3030
CMD ["pnpm", "start"]
