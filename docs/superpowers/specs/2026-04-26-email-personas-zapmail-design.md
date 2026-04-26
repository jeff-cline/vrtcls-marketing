# Persona-aware multi-mailbox sending — design

Date: 2026-04-26
Status: in-progress
Author: Claude (with jeff.cline@me.com)

## Goal

Replace the single-`From` Resend marketing path with a per-mailbox, per-persona sending model that supports cold outreach via Zapmail-provisioned Google Workspace seats. Add user-editable templates, send-test, and persona-aware reporting.

## Scope (this spec)

Phases A → C in one cohesive implementation. Phase D (persona-tailored content authoring) handled inline as 5 seed templates.

## Decisions (defaults — flag if any need to change)

1. **Sending split**
   - Marketing sends → per-mailbox SMTP via `nodemailer` (Zapmail = Google Workspace; standard smtp+app-password auth).
   - Transactional sends (admin pings, "your leads are ready") → Resend, unchanged.

2. **Persona ↔ mailbox cardinality**
   - One persona per mailbox (1:1). Simpler model, matches how cold-email shops actually run mailboxes. A persona row can be reused conceptually, but a mailbox always has exactly one persona attached.

3. **Mailbox ownership**
   - Each mailbox has an `owner_user_id`. Admin manages all; admin can reassign. User can pick from the mailboxes they own at compose time.

4. **From-header construction**
   - `From: "{{persona.display_name}}" <{{mailbox.smtp_user}}>`
   - Address must equal the authenticated SMTP user (DMARC alignment). Display name is the persona.

5. **Per-user templates**
   - Add nullable `email_templates.owner_user_id`. NULL = global admin library; set = user-private template. Replace the `slug UNIQUE` constraint with a `(owner_user_id, slug)` partial uniqueness so users can fork a global slug.
   - Editing a global template as a user creates a fork (copy with `owner_user_id = me`), leaving the global untouched.

6. **Send Test**
   - New `POST /app/templates/:id/send-test`: renders with sample lead data, sends to the logged-in user's email via the user's currently-selected mailbox (or first available).

7. **Persona/mailbox in reports**
   - Add `persona_id`, `mailbox_id` to `sends`. Reports view gets two new groupings: "by persona" and "by mailbox" alongside existing campaign view.

8. **Deliverability — what's in scope**
   - Per-mailbox daily cap (default 50/day, configurable). Tracked via `mailboxes.sends_today` + `last_send_at`, reset on UTC date change.
   - Suppression table (manual + unsubscribe-driven). Pre-send check skips suppressed addresses.
   - Bounce ingestion via IMAP is **out of scope** for this PR — admin can manually mark a send as `bounced` from the campaign detail view. (Real bounce handling is a follow-up — needs IMAP polling on each mailbox.)

9. **Credential storage**
   - SMTP passwords stored plaintext in DB for v1 (single-tenant box, root-owned). Note in spec: encrypt at rest is a follow-up.

## Schema changes (migration `003_personas_mailboxes.sql`)

```sql
CREATE TABLE personas (
  id            BIGSERIAL PRIMARY KEY,
  display_name  TEXT NOT NULL,            -- "Sarah Chen"
  title         TEXT,                     -- "Customer success @ Acme"
  bio           TEXT,                     -- short writer voice / about
  signature_html TEXT,                    -- pre-rendered closing block
  avatar_url    TEXT,
  created_by    BIGINT REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE mailboxes (
  id              BIGSERIAL PRIMARY KEY,
  owner_user_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  persona_id      BIGINT REFERENCES personas(id) ON DELETE SET NULL,
  label           TEXT NOT NULL,          -- "Sarah primary"
  smtp_host       TEXT NOT NULL DEFAULT 'smtp.gmail.com',
  smtp_port       INTEGER NOT NULL DEFAULT 587,
  smtp_secure     BOOLEAN NOT NULL DEFAULT FALSE,  -- false = STARTTLS on 587
  smtp_user       TEXT NOT NULL,          -- mailbox email (the From address)
  smtp_pass       TEXT NOT NULL,          -- app password
  daily_cap       INTEGER NOT NULL DEFAULT 50,
  sends_today     INTEGER NOT NULL DEFAULT 0,
  last_send_at    TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','paused','warming','disabled')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_mailboxes_owner ON mailboxes(owner_user_id);

ALTER TABLE email_templates
  ADD COLUMN owner_user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE email_templates DROP CONSTRAINT email_templates_slug_key;
CREATE UNIQUE INDEX uniq_template_slug_global ON email_templates(slug)
  WHERE owner_user_id IS NULL;
CREATE UNIQUE INDEX uniq_template_slug_user ON email_templates(owner_user_id, slug)
  WHERE owner_user_id IS NOT NULL;

ALTER TABLE sends
  ADD COLUMN persona_id BIGINT REFERENCES personas(id) ON DELETE SET NULL,
  ADD COLUMN mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE SET NULL,
  ADD COLUMN bounced_at TIMESTAMPTZ;

ALTER TABLE campaigns
  ADD COLUMN mailbox_id BIGINT REFERENCES mailboxes(id) ON DELETE SET NULL;

CREATE TABLE suppressions (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  reason      TEXT NOT NULL,             -- 'unsubscribed' | 'bounced' | 'complained' | 'manual'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## New code surface

| File | Purpose |
|---|---|
| `src/services/smtpSender.js` | Per-mailbox nodemailer pool; `sendViaMailbox({ mailboxId, from, to, subject, html, replyTo })`. |
| `src/services/personas.js` | CRUD helpers for personas. |
| `src/services/mailboxes.js` | CRUD + `pickMailbox(userId)` (returns active, under-cap, longest-cold). |
| `src/services/email.js` (modified) | `sendOne` now resolves a mailbox; uses SMTP if mailbox set, else falls back to Resend with global From. |
| `src/services/templates.js` (modified) | Add `mergePersonaVars()` so `{{persona_name}}`, `{{persona_signature}}` work in subject/body. |
| `src/routes/admin.js` (modified) | Adds `/admin/mailboxes`, `/admin/personas` CRUD. |
| `src/routes/user.js` (modified) | Adds `/app/templates`, `/app/templates/:id/send-test`, `/app/mailboxes` (read-only list of theirs), mailbox picker in compose. |
| `src/views/admin/mailboxes.ejs` | Mailbox list + add form + per-row edit/delete + test button. |
| `src/views/admin/personas.ejs` | Persona list + add form + per-row edit/delete. |
| `src/views/user/templates.ejs` | User template list (own + globals); fork-to-edit; save; send-test. |
| `src/views/user/compose.ejs` (modified) | Mailbox picker. |
| `src/views/admin/reports.ejs` (modified) | Persona + mailbox breakdowns. |
| `src/seed.js` (modified) | Adds 5 persona-flavored template seeds (in addition to the existing 5 generic ones, keyed under different slugs). |

## Sending flow (after this change)

1. User composes campaign, picks template + leads + **mailbox**.
2. `sendOne` looks up mailbox; reads `persona_id`.
3. Renders subject/body, substituting persona vars.
4. Builds `From: "Persona Name" <mailbox.smtp_user>`.
5. `smtpSender.sendViaMailbox` → nodemailer transport (pooled per-mailbox).
6. On success: `sends` row gets `persona_id`, `mailbox_id`, `provider_id` (SMTP message-id), `sent_at`. Mailbox `sends_today++`.
7. On failure: `sends.status='failed'`, `sends.error` set. Mailbox NOT charged a day-cap.
8. If mailbox at daily cap: `sendOne` throws `mailbox_capped` — campaign marks remaining sends as `queued` for tomorrow.

## Tracking (unchanged on the wire)

`/c/:sendId/:linkKey` and `/p/:sendId.gif` already write `click_events` and `sends.opened_at`. Reports add persona/mailbox grouping; no new tracking endpoints.

## Out of scope (follow-up PRs)

- IMAP-based bounce/complaint ingestion.
- Encrypted SMTP password at rest.
- Mailbox warm-up automation.
- Multi-step drips triggered by click tags.
- Rotation across mailboxes mid-campaign (v1: one mailbox per campaign).
