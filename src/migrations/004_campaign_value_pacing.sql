-- Per-campaign CTA + customer-value inputs and scheduled (paced) sending.
-- The scheduler distributes a campaign's sends across a sender-time window
-- with a per-mailbox daily cap, so we don't burn warmed Zapmail seats.

ALTER TABLE campaigns
  ADD COLUMN cta_label                 TEXT,
  ADD COLUMN cta_url                   TEXT,
  ADD COLUMN customer_ltv_cents        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN value_multiplier_pct      INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN sends_per_persona_per_day INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN send_window_start_hour    INTEGER NOT NULL DEFAULT 9,
  ADD COLUMN send_window_end_hour      INTEGER NOT NULL DEFAULT 18;

-- Allow new lifecycle states. Existing CHECK constraint blocked us.
ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
ALTER TABLE campaigns ADD CONSTRAINT campaigns_status_check
  CHECK (status IN ('draft','scheduled','sending','sent','paused','canceled'));

ALTER TABLE sends
  ADD COLUMN scheduled_for TIMESTAMPTZ;

-- Worker query: queued + due + active mailbox.
CREATE INDEX idx_sends_queue ON sends(scheduled_for) WHERE status = 'queued';
