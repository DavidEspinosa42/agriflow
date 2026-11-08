# ADR 0003: Idempotent sync with unique session IDs

Status: Accepted

## Context

Connectivity is intermittent, so uploads will repeat, arrive late or arrive out of order.

## Decision

The controller creates a UUID per session. The server upserts on session_id and replies with a per-session acknowledgment. A session stays pending until acknowledged. Retries use exponential backoff with jitter.

## Consequences

Replays and duplicates are harmless. The controller must keep pending sessions until acknowledged, and the server must acknowledge only after durable storage.
