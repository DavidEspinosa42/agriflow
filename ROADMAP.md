# Roadmap

## Before you start

Read, in order: `README.md`, `docs/domain.md`, `AGENTS.md`, `docs/adr/`, then this file.

## Initial version (v1)

Done: core domain with property tests for the three invariants, SQLite controller with simulated
hardware, MySQL server with an idempotent sync endpoint and manager reports, the operator kiosk and
the manager dashboard in Angular, CLI scripts, an offline-outage end-to-end test, and CI.

Not done, and worth knowing before any real use: the GPIO driver is covered by tests against fake
processes only and has never run on a Raspberry Pi; the relay has no hardware watchdog; the pulse
counter can miss the last few pulses at stop (see [ADR 0005](docs/adr/0005-hardware-abstraction-with-simulators.md)).

## Next work

Estimates are in hours. Each includes tests and documentation.

### Hardware and field readiness

| Item                                                       | Hours |
| ---------------------------------------------------------- | ----- |
| GPIO relay and pulse-meter driver tested on a Raspberry Pi | 10    |
| Hardware watchdog so the relay fails off by itself         | 6     |
| Hardware pulse counter and settle step before finalizing   | 8     |
| Show degraded hardware (dead monitor) on the kiosk         | 3     |
| Meter calibration procedure and tooling                    | 6     |
| systemd units, kiosk boot, pump-off default at boot        | 6     |
| UPS and graceful shutdown handling                         | 6     |
| Enclosure, glove-friendly UI tuning in sunlight            | 8     |

### Operations and data

| Item                                                           | Hours |
| -------------------------------------------------------------- | ----- |
| Reference data distribution: machines and fobs from the server | 12    |
| Retention, backup and deletion policy implementation           | 8     |
| Fob revoke and lost-fob workflow                               | 6     |
| Corrections workflow with manager approval                     | 8     |
| Multi-tank and multi-device support                            | 10    |

Today machines and fobs are enrolled on each controller with the CLI, and the server only knows
them through the sessions it receives. A single place to manage them is the biggest gap for a
farm with more than one pump.

### Reporting and dashboard

| Item                                            | Hours |
| ----------------------------------------------- | ----- |
| CSV export of consumption by machine and period | 6     |
| Tank reconciliation against deliveries          | 10    |
| Anomaly alerts (unusual volume, off-hours)      | 8     |
| Machine names and tank labels in the dashboard  | 4     |

### Security

| Item                                                   | Hours |
| ------------------------------------------------------ | ----- |
| Manager accounts, roles and session expiry             | 10    |
| Rate limiting and TLS termination guide for the server | 4     |
| Device token rotation from the dashboard               | 4     |
| Dependency and supply-chain audit in CI                | 4     |

**Total: 147 hours**

## Out of scope

Payments and billing, tank level telemetry, legal metrology certification, blockchain ledgers,
native mobile apps, biometric identification.
