# ADR 0002: MySQL for central records

Status: Accepted

## Context

Consolidated records and reporting need a shared database the farm can host and query.

## Decision

Use MySQL with Drizzle and mysql2 on the central server. The unique key on session_id enforces one transaction per session.

## Consequences

Familiar, widely hosted. Local development needs a MySQL instance, which departs from the preference for no installed services; this is accepted and documented in the README.
