-- HITT (High Intent Targeted Traffic) request — user submits keyword + geo,
-- system queues it, admin fulfills via MCP pull (or future WattData direct API).
CREATE TABLE hitt_requests (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  city           TEXT,
  state          TEXT,
  zip            TEXT,
  radius_miles   INTEGER NOT NULL DEFAULT 25,
  audience_limit INTEGER NOT NULL DEFAULT 500,
  status         TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','baking','complete','failed')),
  audience_id    BIGINT REFERENCES audiences(id) ON DELETE SET NULL,
  result_count   INTEGER,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ
);

CREATE INDEX idx_hitt_user ON hitt_requests(user_id);
CREATE INDEX idx_hitt_status ON hitt_requests(status);

-- Tie audience to a hitt_request
ALTER TABLE audiences ADD COLUMN hitt_request_id BIGINT REFERENCES hitt_requests(id) ON DELETE SET NULL;
CREATE INDEX idx_audiences_hitt ON audiences(hitt_request_id);

-- Admin impersonation audit
CREATE TABLE impersonations (
  id             BIGSERIAL PRIMARY KEY,
  admin_id       BIGINT NOT NULL REFERENCES users(id),
  target_user_id BIGINT NOT NULL REFERENCES users(id),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at       TIMESTAMPTZ
);

CREATE INDEX idx_impersonations_admin ON impersonations(admin_id);
