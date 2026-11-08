# Roadmap

## Before you start

Read, in order: `README.md`, `docs/domain.md`, `AGENTS.md`, `docs/adr/`, then this file.

## Initial version (v1)

Core domain with property tests, SQLite controller with simulated hardware, MySQL server with an
idempotent sync endpoint, operator kiosk and manager dashboard, CLI scripts, offline-outage
end-to-end test, CI.

## Next work

Estimates are in hours.

### Hardware and field readiness

| Item                                                       | Hours |
| ---------------------------------------------------------- | ----- |
| GPIO relay and pulse-meter driver tested on a Raspberry Pi | 10    |
| Hardware watchdog so the relay fails off by itself         | 6     |
| Show degraded hardware (dead monitor) on the kiosk         | 3     |
| Hardware pulse counter and settle step before finalizing   | 8     |
| Meter calibration procedure and tooling                    | 6     |
| systemd units, kiosk boot, pump-off default at boot        | 6     |
| UPS and graceful shutdown handling                         | 6     |
| Enclosure, glove-friendly UI tuning in sunlight            | 8     |

### Operations and data

| Item                                                 | Hours |
| ---------------------------------------------------- | ----- |
| Retention, backup and deletion policy implementation | 8     |
| Fob revoke and lost-fob workflow                     | 6     |
| Corrections workflow with manager approval           | 8     |
| Multi-tank and multi-device support                  | 10    |

### Reporting and dashboard

| Item                                          | Hours |
| --------------------------------------------- | ----- |
| Consumption by machine and period, CSV export | 8     |
| Tank reconciliation against deliveries        | 10    |
| Anomaly alerts (unusual volume, off-hours)    | 8     |

### Security

| Item                                    | Hours |
| --------------------------------------- | ----- |
| Device token rotation                   | 4     |
| Manager accounts and roles              | 10    |
| Dependency and supply-chain audit in CI | 4     |

**Total: 129 hours**

## Out of scope

Payments and billing, tank level telemetry, legal metrology certification, blockchain ledgers,
native mobile apps, biometric identification.
