# Domain

AgriFlow controls and audits diesel dispensing from a central farm tank at a private farm
fueling point in Argentina.

## Glossary

| Term               | Meaning                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| Farm               | The single private operation that owns the tank, pump and machines.               |
| Tank               | The central diesel storage tank. Identified by a tank ID.                         |
| Pump controller    | The Raspberry Pi beside the dispenser. Enables the pump and records sessions.     |
| Device             | A pump controller as known to the central server (device ID plus token).          |
| Operator           | A person authorized to refuel. Known only by a pseudonymous operator ID.          |
| Fob                | Farm-issued RFID key fob. Its UID is the credential reference.                    |
| Credential         | The binding of a fob to an operator, with permissions and an expiry.              |
| Machine            | A tractor, truck or implement that receives diesel. Selected by equipment number. |
| Equipment number   | The short number painted on the machine, entered on the touchscreen.              |
| Authorization      | A local, time-limited permission to dispense for one operator and one machine.    |
| Session            | One refueling event from authorization to finalization. Has a unique session ID.  |
| Checkpoint         | A periodic durable record of liters delivered during a running session.           |
| Ledger             | The append-only local record of sessions and audit entries.                       |
| Correction         | A new audit entry linked to an earlier session. Never an overwrite.               |
| Outbox             | Finalized sessions waiting for server acknowledgment.                             |
| Acknowledgment     | The server's reply that a session is durably stored centrally.                    |
| Calibration factor | Liters per flow-meter pulse for one device.                                       |
| E-stop             | Physical emergency stop that cuts pump power independently of software.           |

## Rules

Every default below is a per-instance setting stored in the `settings` table, not a constant.

1. **Access.** The pump is enabled only when the fob is known, its credential is unexpired and not
   revoked, the operator may use the selected machine, and the machine is identified.
   Otherwise the pump stays disabled and the denial is audited with a reason.
2. **Authorization window.** An authorization lasts `authorizationTtlSeconds` (default 60) from
   fob presentation. If dispensing has not started by then, it lapses.
3. **Session limits.** A session ends when the operator stops it, `maxSessionLiters` (default 600)
   is reached, no flow is seen for `idleTimeoutSeconds` (default 120), or a fault occurs.
4. **Faults and restarts.** Any fault, E-stop signal, flow-meter anomaly or process restart
   leaves the pump disabled. An unfinished session is recorded as interrupted, never resumed.
5. **Metering.** Liters are pulses multiplied by the calibration factor. Liters never decrease
   within a session.
6. **Durability.** Dispensing progress is checkpointed every `checkpointIntervalSeconds`
   (default 2) and on every state change.
7. **Append-only.** Finalized sessions are never updated. Corrections add linked audit entries.
8. **Sync.** Each session has a unique ID created on the controller. The server stores at most one
   transaction per session ID. A session stays pending until acknowledged. Retries use
   exponential backoff starting at `syncRetryBaseSeconds` (default 5) up to
   `syncRetryMaxSeconds` (default 900).
9. **Emergency stop.** The E-stop is hardware wired in series with pump power. Software only
   observes it and records the event.

## Reference scenario

During an internet outage, operator `op-0007` presents fob `04A1B2C3` and enters equipment number
`T-12` (a tractor). The controller authorizes, enables the pump, and the operator dispenses
84.3 L. The session is finalized and stored in SQLite with status `pending`. When connectivity
returns, the controller uploads it. The server stores one transaction and acknowledges.
The session becomes `acked`. A repeated upload of the same session ID changes nothing.
`pnpm seed` reproduces this scenario with dummy data.
