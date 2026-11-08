# ADR 0008: Angular for the kiosk and the dashboard

Status: Accepted

## Context

The operator screen and the manager dashboard share types and visual language.

## Decision

Build both in one Angular workspace as two applications with a shared library. The controller serves the kiosk build, shown in Chromium kiosk mode.

## Consequences

One framework and shared client types. The kiosk build must stay small enough for a Raspberry Pi.

## Workspace layout

`apps/dashboard` is an Angular CLI workspace with three projects: `kiosk` and `manager` (applications) and `shared`, plain TypeScript with no Angular dependency, imported through the `@agriflow/shared` path alias. `shared` holds the controller WebSocket client, the typed manager API client and formatting, so they run under the root Vitest without a browser. Protocol schemas (`operator-protocol`, `manager-protocol`) live in `@agriflow/core`, so the controller, the server tests and the dashboard validate against the same definitions.

Angular 22 requires TypeScript 6.0, so the dashboard pins its own TypeScript while the rest of the repository uses 7.x. Component tests use Angular's Vitest runner with jsdom (`pnpm --filter @agriflow/dashboard test`). Versions are the newest that satisfy the repository's seven-day release-age rule.
