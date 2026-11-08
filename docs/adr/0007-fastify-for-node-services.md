# ADR 0007: Fastify for the Node services

Status: Accepted

## Context

Both the controller and the server need a small, typed HTTP layer.

## Decision

Use Fastify with zod validation on both services.

## Consequences

Light footprint on the Pi and one framework to learn. Less structure than heavier frameworks, so conventions live in AGENTS.md.
