CREATE TABLE operation_leases (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES operations(operation_id) ON DELETE CASCADE,
  worker_id TEXT,
  instance_id TEXT,
  last_heartbeat_at TEXT,
  expires_at TEXT NOT NULL,
  completion_hash TEXT,
  completion_valid INTEGER CONSTRAINT operation_completion_valid CHECK (completion_valid IS NULL OR completion_valid = 1)
);
--> statement-breakpoint
CREATE INDEX idx_operation_leases_expiry ON operation_leases(expires_at);
