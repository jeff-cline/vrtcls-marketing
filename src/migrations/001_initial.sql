-- Users (admins + tool customers)
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  credits_cents INTEGER NOT NULL DEFAULT 0,
  email_tokens  INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Admin-tracked credit / token ledger (audit trail)
CREATE TABLE credit_ledger (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta_cents INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  created_by  BIGINT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE token_ledger (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  ref_id     BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Keywords a user has registered (intent prompts)
CREATE TABLE keywords (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label               TEXT NOT NULL,
  prompt              TEXT NOT NULL,
  cluster_expression  TEXT,
  estimated_size      INTEGER,
  geo                 JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One audience = one MCP pull snapshot
CREATE TABLE audiences (
  id             BIGSERIAL PRIMARY KEY,
  keyword_id     BIGINT REFERENCES keywords(id) ON DELETE SET NULL,
  workflow_id    TEXT,
  tool_trace_id  TEXT,
  source_url     TEXT,
  total_count    INTEGER,
  imported_by    BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The lead pool. person_id from MCP is the stable identity.
CREATE TABLE leads (
  id           BIGSERIAL PRIMARY KEY,
  person_id    TEXT NOT NULL UNIQUE,
  email        TEXT,
  phone        TEXT,
  first_name   TEXT,
  last_name    TEXT,
  address      JSONB,
  dnc          BOOLEAN NOT NULL DEFAULT FALSE,
  first_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_leads_first_seen ON leads(first_seen);
CREATE INDEX idx_leads_email ON leads(email);

-- Many-to-many: leads ↔ tags. This is the attribution brain.
CREATE TABLE lead_tags (
  id         BIGSERIAL PRIMARY KEY,
  lead_id    BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(lead_id, tag)
);

CREATE INDEX idx_lead_tags_tag ON lead_tags(tag);

-- Tie leads to the audience they came in on
CREATE TABLE audience_leads (
  audience_id BIGINT NOT NULL REFERENCES audiences(id) ON DELETE CASCADE,
  lead_id     BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  PRIMARY KEY (audience_id, lead_id)
);

-- A user "buys" leads. 5 tokens granted per lead. Age tier determines price.
CREATE TABLE lead_purchases (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lead_id        BIGINT NOT NULL REFERENCES leads(id) ON DELETE RESTRICT,
  price_cents    INTEGER NOT NULL,
  tier_days      INTEGER NOT NULL,
  tokens_granted INTEGER NOT NULL DEFAULT 5,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, lead_id)
);

CREATE INDEX idx_lead_purchases_user ON lead_purchases(user_id);

-- Email templates
CREATE TABLE email_templates (
  id         BIGSERIAL PRIMARY KEY,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body_html  TEXT NOT NULL,
  links      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A campaign = template + audience subset + sender
CREATE TABLE campaigns (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id   BIGINT NOT NULL REFERENCES email_templates(id),
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent','paused')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per individual email send
CREATE TABLE sends (
  id           BIGSERIAL PRIMARY KEY,
  campaign_id  BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  lead_id      BIGINT NOT NULL REFERENCES leads(id),
  provider_id  TEXT,
  status       TEXT NOT NULL DEFAULT 'queued',
  sent_at      TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  opened_at    TIMESTAMPTZ,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sends_campaign ON sends(campaign_id);
CREATE INDEX idx_sends_lead ON sends(lead_id);

-- Every tracked click
CREATE TABLE click_events (
  id         BIGSERIAL PRIMARY KEY,
  send_id    BIGINT NOT NULL REFERENCES sends(id) ON DELETE CASCADE,
  link_key   TEXT NOT NULL,
  destination TEXT NOT NULL,
  user_agent TEXT,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_click_events_send ON click_events(send_id);
CREATE INDEX idx_click_events_link ON click_events(link_key);
