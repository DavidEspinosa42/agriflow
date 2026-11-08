# ADR 0004: The emergency stop is hardware

Status: Accepted

## Context

Emergency shutdown must work when software has crashed or is wedged.

## Decision

A physical E-stop is wired in series with pump power. Software only observes the signal and records the event. The pump relay defaults to off at boot through a pull-down.

## Consequences

Safety does not depend on code. Software cannot re-enable the pump while the E-stop is engaged. Installers must wire and test it.
