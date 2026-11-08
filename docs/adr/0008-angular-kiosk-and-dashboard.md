# ADR 0008: Angular for the kiosk and the dashboard

Status: Accepted

## Context

The operator screen and the manager dashboard share types and visual language.

## Decision

Build both in one Angular workspace as two applications with a shared library. The controller serves the kiosk build, shown in Chromium kiosk mode.

## Consequences

One framework and shared client types. The kiosk build must stay small enough for a Raspberry Pi.
