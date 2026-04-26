-- Zapmail integration: link our mailbox rows back to the Zapmail mailbox id
-- so we can sync status, re-pull credentials, and order new mailboxes.

ALTER TABLE mailboxes
  ADD COLUMN zapmail_id TEXT;

CREATE INDEX idx_mailboxes_zapmail_id ON mailboxes(zapmail_id) WHERE zapmail_id IS NOT NULL;
