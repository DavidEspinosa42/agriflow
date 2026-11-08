# ADR 0001: SQLite on the pump controller

Status: Accepted

## Context

The controller must record sessions durably through internet outages and power interruptions on a Raspberry Pi.

## Decision

Use SQLite in WAL mode with synchronous=FULL through the built-in `node:sqlite` module, which avoids a native build on Windows and the Raspberry Pi. One file, no service to run.

## Consequences

Durable local storage without installed services. Single writer fits one controller. Backups must use SQLite's online backup API (`backup()` from `node:sqlite`) or a checkpointed, closed database; copying the live `.db` file alone can miss committed records still in the `-wal` file. The schema must be migrated by the controller itself. The Pi must run the same Node version as development.
