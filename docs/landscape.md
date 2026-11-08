# Landscape

Dated 2026-11-08. Alternatives and how AgriFlow relates to each.

| Alternative                                                     | What it is                                                       | Relation to AgriFlow                                                                                                              |
| --------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Commercial fuel management systems (forecourt and fleet suites) | Turnkey pumps with card or tag authorization and cloud reporting | Typically complete but costly and closed; some assume connectivity. AgriFlow targets a single private tank on commodity hardware. |
| Aftermarket pump controllers with RFID                          | Dedicated boxes with tag readers and local logs                  | Closest in function. Usually proprietary firmware with limited audit export. AgriFlow keeps an open, append-only ledger.          |
| Telemetry-only tank gauges                                      | Level sensors with cloud dashboards                              | Measure the tank, not who took fuel. Complementary, out of scope for v1.                                                          |
| Paper logbooks and spreadsheets                                 | Manual entry at the tank                                         | No access control or metering, error-prone. The status quo AgriFlow replaces.                                                     |
| General ERP fuel modules                                        | Accounting-level fuel tracking                                   | Record purchases and consumption after the fact. No pump control.                                                                 |

## Differentiation

AgriFlow is deliberately small. It enforces access at the pump, keeps working offline,
records every session in an append-only local ledger, and syncs idempotently to a central
database the farm owns. It collects only pseudonymous operator IDs. It does not replace
commercial dispensers' legal metrology certification, which a deployment must address separately.
