-- Personas: writer voice / display identity attached to a mailbox.
CREATE TABLE personas (
  id             BIGSERIAL PRIMARY KEY,
  display_name   TEXT NOT NULL,
  title          TEXT,
  bio            TEXT,
  signature_html TEXT,
  avatar_url     TEXT,
  created_by     BIGINT REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Mailboxes: SMTP-authed sender accounts (Zapmail-provisioned Google Workspace seats).
CREATE TABLE mailboxes (
  id             BIGSERIAL PRIMARY KEY,
  owner_user_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  persona_id     BIGINT REFERENCES personas(id) ON DELETE SET NULL,
  label          TEXT NOT NULL,
  smtp_host      TEXT NOT NULL DEFAULT 'smtp.gmail.com',
  smtp_port      INTEGER NOT NULL DEFAULT 587,
  smtp_secure    BOOLEAN NOT NULL DEFAULT FALSE,
  smtp_user      TEXT NOT NULL,
  smtp_pass      TEXT NOT NULL,
  daily_cap      INTEGER NOT NULL DEFAULT 50,
  sends_today    INTEGER NOT NULL DEFAULT 0,
  last_send_at   TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','paused','warming','disabled')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_mailboxes_owner ON mailboxes(owner_user_id);
CREATE INDEX idx_mailboxes_persona ON mailboxes(persona_id);

-- Per-user template forks. NULL owner = global admin library.
ALTER TABLE email_templates
  ADD COLUMN owner_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE email_templates DROP CONSTRAINT email_templates_slug_key;
CREATE UNIQUE INDEX uniq_template_slug_global ON email_templates(slug)
  WHERE owner_user_id IS NULL;
CREATE UNIQUE INDEX uniq_template_slug_user ON email_templates(owner_user_id, slug)
  WHERE owner_user_id IS NOT NULL;

-- Persona/mailbox attribution on individual sends.
ALTER TABLE sends
  ADD COLUMN persona_id BIGINT REFERENCES personas(id) ON DELETE SET NULL,
  ADD COLUMN mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE SET NULL,
  ADD COLUMN bounced_at TIMESTAMPTZ;

CREATE INDEX idx_sends_persona ON sends(persona_id);
CREATE INDEX idx_sends_mailbox ON sends(mailbox_id);

ALTER TABLE campaigns
  ADD COLUMN mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE SET NULL;

-- Suppressions: emails that should never be sent to.
CREATE TABLE suppressions (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  reason      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_suppressions_email ON suppressions(email);
