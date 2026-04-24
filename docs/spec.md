# vrtcls.marketing — MVP Spec

## Purpose

A self-serve outbound email tool that turns intent signals into delivered emails, measures clicks, and feeds every click back into the lead record so the next send is sharper. Sell access by the lead, not by the month.

## Users

- **Admin** (Jeff). Imports lead pulls from the HighIntentTargets MCP, grants credits to users, edits templates, watches global stats.
- **User**. Signs up, gets $5 welcome credit, saves keywords, buys leads, sends emails, watches click attribution.

## Core value loop

1. User saves a keyword (natural language intent).
2. Admin pulls leads via MCP in a Claude session → exports JSON → imports to pool, tagged with the keyword.
3. User browses the pool, filtered by age-tier pricing, buys leads.
4. Each purchase grants 5 send tokens.
5. User composes with a template + selected leads → 1 token per send.
6. Every link in the email is tracked. Every click writes a `clicked:<link_key>` tag on the lead.
7. Each lead accumulates tags over time. Future keywords don't duplicate — they append. The lead profile compounds.

## Pricing model

Leads are priced by age of the lead's first pull:

| Age         | Price  |
|-------------|--------|
| ≤ 24 hours  | $5.00  |
| ≤ 7 days    | $2.50  |
| ≤ 30 days   | $1.00  |
| > 30 days   | $0.50  |

Every lead purchase grants **5 send tokens** (one email = one token). Users cannot buy tokens separately in MVP.

## Data model (Postgres)

- `users` — id, email, password_hash, role (admin/user), credits_cents, email_tokens
- `credit_ledger`, `token_ledger` — audit trails
- `keywords` — per-user intent prompts
- `audiences` — one row per MCP pull (workflow_id, tool_trace_id, import count)
- `leads` — person_id (stable from MCP), email, phone, name, address, dnc, first_seen
- `lead_tags` — (lead_id, tag, source) unique; the **attribution brain**
- `audience_leads` — join between audiences and leads
- `lead_purchases` — (user_id, lead_id, price_cents, tier_days, tokens_granted)
- `email_templates` — slug, name, subject, body_html, links
- `campaigns` — user_id, template_id, name, status
- `sends` — campaign_id, user_id, lead_id, provider_id, status, sent/delivered/opened timestamps
- `click_events` — send_id, link_key, destination, user_agent, ip

## Routes

### Public
- `GET /` — landing
- `GET /pricing`
- `GET /login`, `POST /login`
- `GET /signup`, `POST /signup`
- `POST /logout`

### User (auth-gated)
- `GET /app` — dashboard
- `GET/POST /app/keywords`
- `GET /app/leads` — marketplace
- `POST /app/leads/:id/buy`
- `GET /app/my-leads`
- `GET /app/compose`
- `POST /app/send`
- `GET /app/campaigns`
- `GET /app/campaigns/:id`

### Admin (admin-gated)
- `GET /admin` — global stats
- `GET /admin/users` / `POST /admin/users/:id/credits`
- `GET /admin/import` / `POST /admin/import` — paste MCP JSON, imports to pool
- `GET /admin/templates` / `POST /admin/templates/:id`

### Tracking
- `GET /c/:sendId/:linkKey?u=<dest>` — log click + upsert lead tag + redirect
- `GET /p/:sendId.gif` — open pixel
- `GET /u/:sendId` — one-click unsubscribe (sets lead.dnc=true)

## Email delivery

- **MVP provider:** Resend. Dev mode (no RESEND_API_KEY) logs instead of sending.
- **Phase 3:** Zapmail adapter (`src/services/zapmail.js` stub) once API key + docs available. Supports 50-account/day rotation for deliverability.
- Every send: substitute vars, append CAN-SPAM footer (address + unsub link), rewrite `<a>` tags, inject open pixel.

## Five starter templates

All plain-text-feel HTML, real personalization, CAN-SPAM compliant footer auto-appended:
1. Soft Intro — "noticed folks in {{city}}..."
2. Question Hook — "still comparing or already decided?"
3. Useful Resource — "guide that's helping people in {{state}}"
4. Peer Proof — "N people in {{zip}} signed up last month"
5. Direct Offer — "open through the end of the week"

Each carries ≥2 tracked links marked `data-link-key="<slug>"`. Those slugs become tags on click.

## Security

- Bcrypt cost 12. Sessions signed HttpOnly + SameSite=Lax + Secure in prod.
- Admin seeded from env on first `npm run seed`. Password never committed.
- Tracking URLs validate send_id exists before logging; destination pulled from querystring.
- Admin-only imports of person data.
- One-click unsubscribe sets `leads.dnc = TRUE`; `/app/leads` filters it out.

## Explicitly out of scope (MVP)

- Public-site WYSIWYG editor (Phase 2)
- Stripe / self-serve credit purchase (Phase 2)
- Zapmail live integration (Phase 3, needs API key/docs)
- Multi-sender rotation / 50-account/day (Phase 3)
- Automated follow-up drips triggered by tag creation (Phase 3)
- DataForSEO keyword research UI (Phase 3)
- CPA / revenue attribution (needs revenue source)

## Known follow-ups before public launch

- Rate limit `/login`, `/signup`, `/c/`, `/p/`
- Switch session store from in-memory to Redis (multi-process PM2)
- Automated Postgres backups
- SPF/DKIM/DMARC set on domain (see `docs/DEPLOY.md`)
- Warm-up send plan so Resend domain reputation builds gradually
