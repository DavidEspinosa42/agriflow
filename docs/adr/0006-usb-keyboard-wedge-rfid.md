# ADR 0006: USB keyboard-wedge RFID reader

Status: Accepted

## Context

Operators need a cheap, replaceable reader for farm-issued fobs.

## Decision

Target USB readers that present the fob UID as keystrokes ending in Enter. The driver reads the UID from the input stream and the credential reference is the hashed UID.

## Consequences

Common hardware, easy to simulate. The UID is not secret and cloning is possible; fobs identify but do not authenticate strongly. Accepted for v1.

## Reading the reader on a Pi

The driver reads raw key events from the reader's device node (`RFID_DEVICE`, for example `/dev/input/by-id/usb-...-event-kbd`) and decodes the UID, so no terminal or focused window is needed. The service user must be in the `input` group.

The events are not grabbed exclusively, so the keystrokes also reach whichever window has focus. The kiosk page therefore has no text input and handles no key events, and the UID never appears in a form. UIDs are hashed before storage and are never logged.
