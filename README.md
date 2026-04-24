# vrtcls.marketing

Intent-based outbound email platform. Pick a keyword → pull live buyers → send a template → clicks write tags back → next send is smarter.

## Stack
- Node 20+ / Fastify 5 / EJS views / Bootstrap 5 (CDN)
- Postgres 16
- Resend (Zapmail adapter stubbed for later)
- Hosted on a Vultr VPS (see `docs/DEPLOY.md`)

## Local setup

```bash
# 1. Install
npm install

# 2. Start Postgres (your choice). Create DB + user:
createdb vrtcls
psql -c "CREATE USER vrtcls WITH PASSWORD 'vrtcls';"
psql -c "GRANT ALL PRIVILEGES ON DATABASE vrtcls TO vrtcls;"

# 3. Copy env
cp .env.example .env
# Then edit .env:
#   - set SESSION_SECRET to a long random string
#   - set ADMIN_EMAIL + ADMIN_PASSWORD (the admin seeded on first `npm run seed`)
#   - optionally set RESEND_API_KEY (without it the app runs in dev mode — emails log only)

# 4. Migrate and seed
npm run migrate
npm run seed

# 5. Run
npm run dev
# → http://localhost:3000
```

## What's in MVP

- Public lander + pricing page
- User signup ($5 welcome credit) / login / logout
- Admin panel: users list, grant credits/tokens, import MCP lead pulls, edit templates
- User dashboard: balance, token count, activity
- Keyword saver
- Lead marketplace (age-tiered: $5 / $2.50 / $1.00 / $0.50) with "Buy" button
- "My Leads" view
- Compose: pick template + leads → send
- Campaigns list + per-campaign detail (sent / opened / clicked)
- Click tracking that writes tags back to `lead_tags`
- Open tracking (1×1 pixel)
- One-click unsubscribe

## What's NOT in MVP (by design)

- WYSIWYG public-site editor (Phase 2)
- Self-serve credit purchase (Stripe) — admin grants for now
- Zapmail API integration — adapter is stubbed; need API key + docs
- Multi-sender 50/day rotation (Phase 3)
- Automated follow-up drips triggered by click tags (Phase 3)
- DataForSEO keyword research (Phase 3)
- CPA / revenue attribution (needs revenue data source)

## How the outbound loop works

1. Admin runs a HighIntentTargets MCP pull (inside a Claude session) — exports JSON.
2. Admin opens `/admin/import`, pastes JSON + a keyword tag, imports → leads go into the pool, each tagged with the keyword.
3. Users browse `/app/leads`, see leads tiered by age, buy what they want.
4. Each purchase grants 5 send tokens.
5. User composes at `/app/compose`, picks a template + leads → 1 token consumed per send.
6. Each link in the email is rewritten to `/c/:sendId/:linkKey?u=<dest>`. Click logs the event AND writes a `clicked:<linkKey>` tag on the lead.
7. Open pixel at `/p/:sendId.gif` logs opens.
8. Unsubscribe at `/u/:sendId` flips lead to DNC.

Lead `person_id` is stable across imports → future pulls for different keywords append tags to the same lead. Never duplicates.

## Security notes

- Passwords bcrypt-hashed, cost 12.
- Sessions signed cookies, HttpOnly, SameSite=Lax, Secure in prod.
- Admin credentials come from env vars only — never committed.
- Tracking URLs include a random `provider_id`; link keys are whitelisted per template.
- Add rate limiting before production launch (not in MVP — see `docs/DEPLOY.md`).

## Deploy

See `docs/DEPLOY.md` for Vultr provisioning, nginx + Let's Encrypt, PM2, and DNS (SPF/DKIM/DMARC) setup.
