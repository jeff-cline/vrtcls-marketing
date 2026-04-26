-- Inbox: messages received at each persona's mailbox (Gmail IMAP).
-- We use Gmail directly with the same App Password used for SMTP. Zapmail's
-- "Zapbox" UI is also just a reader on top of these mailboxes, so reading
-- Gmail itself is the source of truth.

ALTER TABLE mailboxes
  ADD COLUMN imap_host          TEXT NOT NULL DEFAULT 'imap.gmail.com',
  ADD COLUMN imap_port          INTEGER NOT NULL DEFAULT 993,
  ADD COLUMN imap_secure        BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN inbox_last_synced  TIMESTAMPTZ,
  ADD COLUMN inbox_last_uid     BIGINT;

CREATE TABLE inbox_messages (
  id            BIGSERIAL PRIMARY KEY,
  mailbox_id    BIGINT NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  uid           BIGINT NOT NULL,
  message_id    TEXT,
  thread_id     TEXT,
  in_reply_to   TEXT,
  from_address  TEXT,
  from_name     TEXT,
  to_addresses  TEXT,
  subject       TEXT,
  snippet       TEXT,
  body_text     TEXT,
  body_html     TEXT,
  received_at   TIMESTAMPTZ NOT NULL,
  read_at       TIMESTAMPTZ,
  replied_at    TIMESTAMPTZ,
  raw_headers   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(mailbox_id, uid)
);

CREATE INDEX idx_inbox_messages_mailbox_received
  ON inbox_messages(mailbox_id, received_at DESC);
CREATE INDEX idx_inbox_messages_thread
  ON inbox_messages(thread_id);
CREATE INDEX idx_inbox_messages_unread
  ON inbox_messages(mailbox_id) WHERE read_at IS NULL;
