# ADR 0006: USB keyboard-wedge RFID reader

Status: Accepted

## Context

Operators need a cheap, replaceable reader for farm-issued fobs.

## Decision

Target USB readers that present the fob UID as keystrokes ending in Enter. The driver reads the UID from the input stream and the credential reference is the hashed UID.

## Consequences

Common hardware, easy to simulate. The UID is not secret and cloning is possible; fobs identify but do not authenticate strongly. Accepted for v1.
