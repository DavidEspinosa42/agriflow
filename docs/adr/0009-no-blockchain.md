# ADR 0009: No blockchain

Status: Accepted

## Context

Audit integrity could be pursued with a distributed ledger.

## Decision

Do not use a blockchain. Integrity comes from append-only tables, linked correction entries, restricted database permissions and backups.

## Consequences

Simpler and cheaper. Tamper evidence is limited to what database controls and backups provide; hash chaining can be added later.
