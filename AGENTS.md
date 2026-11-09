# AGENTS.md

## Project

AgriFlow: offline-first diesel dispensing authorization and audit. Raspberry Pi controller
(SQLite) syncs to a central server (MySQL); Angular dashboard for managers. See `README.md`
and `docs/domain.md`.

## Commands

- `pnpm install`
- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm check` (all three)
- `pnpm lint:fix` applies Biome fixes

## Layout

- `packages/core/src/lib/` domain logic, zod schemas, property tests. No I/O.
- `apps/controller/` Fastify, SQLite, hardware abstraction (simulator and GPIO), sync worker.
- `apps/server/` Fastify, Drizzle, MySQL, authenticated sync API.
- `apps/dashboard/` Angular: operator kiosk and manager dashboard.
- `scripts/` CLI tasks. `docs/` documentation and ADRs.

## Rules

- Check current library docs (Context7) before using an API. Pin exact latest stable versions.
- Prefer platform APIs over new dependencies. Add a dependency only when needed.
- Domain code in core is pure and deterministic: time and randomness are passed in.
- Defaults live in settings, not constants.

## Code style

TypeScript with strict flags, ESM, Biome formatting (2 spaces, double quotes, 100 columns).
Validate all external input with zod. No `any`.

## Invariants (never break)

1. The pump activates only with a valid, unexpired local authorization and an identified machine.
   Faults and restarts leave the pump disabled.
2. Dispensing progress is durably recorded locally. Finalized sessions are append-only; corrections
   create linked audit entries and never overwrite records.
3. Synchronization is idempotent: each session has a unique ID, creates at most one central
   transaction, and stays pending until the server acknowledges durable storage.

Each invariant has property-based tests. Do not weaken them.

## Data policy

Pseudonymous operator IDs only. No names, DNI, contact details, biometrics or precise location.
Never log fob UIDs in clear, tokens or secrets.

## Commits

Conventional Commits, lowercase noun-phrase subject, no body, no trailing period. Scope matches the
source folder (`feat(core)`, `feat(controller)`); `docs` and `chore` are unscoped. One concern per
commit. Every commit passes `pnpm check`. Single author, no `Co-authored-by` trailers, no tool
attribution.

## Secrets

Never commit `.env` or tokens. Use `.env.example` for names only.
