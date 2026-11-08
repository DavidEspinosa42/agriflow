# ADR 0010: Offline-first, no cloud dependency for dispensing

Status: Accepted

## Context

The farm may have no internet for hours or days.

## Decision

All authorization data needed to dispense lives on the controller. The server is for reporting and consolidation, never required to authorize.

## Consequences

Dispensing continues during outages. Permission changes made centrally reach the controller only when it syncs, so revocations can lag; the roadmap covers this.
