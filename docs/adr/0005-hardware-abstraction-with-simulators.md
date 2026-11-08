# ADR 0005: Hardware abstraction with simulators

Status: Accepted

## Context

Development happens on Windows, deployment on a Raspberry Pi with GPIO and a USB reader.

## Decision

Define interfaces for pump relay, flow meter, RFID reader and buttons. Ship a simulator and a GPIO implementation behind them, selected by HARDWARE_DRIVER.

## Consequences

Domain and service code is testable without hardware. The real drivers need field testing on a Pi, listed in the roadmap.
