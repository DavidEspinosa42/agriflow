/**
 * Ordered schema migrations. The index + 1 is the PRAGMA user_version after applying it.
 * Never edit a released migration; append a new one.
 */
export const migrations: readonly string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE operators (
    operator_id TEXT PRIMARY KEY
  ) STRICT;

  CREATE TABLE credentials (
    credential_ref TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL REFERENCES operators(operator_id),
    machine_access TEXT NOT NULL,
    expires_at_ms INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
  ) STRICT;

  CREATE TABLE machines (
    machine_id TEXT PRIMARY KEY,
    equipment_number TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
  ) STRICT;

  -- Progress of the one running session. Mutable by design: checkpoints overwrite liters.
  CREATE TABLE open_sessions (
    session_id TEXT PRIMARY KEY,
    operator_id TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    last_checkpoint_at_ms INTEGER NOT NULL,
    liters REAL NOT NULL CHECK (liters >= 0 AND liters < 1e12)
  ) STRICT;

  -- Finalized sessions are append-only (enforced by triggers below).
  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    tank_id TEXT NOT NULL,
    operator_id TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL,
    ended_at_ms INTEGER NOT NULL,
    liters REAL NOT NULL CHECK (liters >= 0 AND liters < 1e12),
    end_reason TEXT NOT NULL
  ) STRICT;

  CREATE TRIGGER sessions_no_update BEFORE UPDATE ON sessions
  BEGIN SELECT RAISE(ABORT, 'sessions are append-only'); END;
  CREATE TRIGGER sessions_no_delete BEFORE DELETE ON sessions
  BEGIN SELECT RAISE(ABORT, 'sessions are append-only'); END;

  CREATE TABLE audit_events (
    entry_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    session_id TEXT,
    operator_id TEXT,
    delta_liters REAL,
    reason TEXT
  ) STRICT;

  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events
  BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events
  BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;

  CREATE TABLE sync_outbox (
    session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'acked', 'conflict')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at_ms INTEGER NOT NULL
  ) STRICT;
  `,
  // Equipment numbers are matched ignoring case, so they must also be unique ignoring case.
  // No installation exists yet; a database with colliding numbers fails here, loudly, and the
  // numbers must be fixed by hand rather than silently merging two machines.
  `
  CREATE UNIQUE INDEX machines_equipment_number_ci ON machines (upper(equipment_number));
  `,
  // Sessions keep the equipment number the machine had at the time. Older rows stay without one
  // because finalized sessions are append-only.
  `
  ALTER TABLE sessions ADD COLUMN equipment_number TEXT;
  `,
];
