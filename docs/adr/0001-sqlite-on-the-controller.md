# ADR 0001: SQLite on the pump controller

Status: Accepted

## Context

The controller must record sessions durably through internet outages and power interruptions on a Raspberry Pi.

## Decision

Use SQLite in WAL mode with synchronous=FULL via better-sqlite3. One file, no service to run.

## Consequences

Durable local storage without installed services. Single writer fits one controller. Backups must use SQLite's online backup API (better-sqlite3 `backup()`) or a checkpointed, closed database; copying the live `.db` file alone can miss committed records still in the `-wal` file. The schema must be migrated by the controller itself.
