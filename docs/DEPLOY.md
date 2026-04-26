# Deploy to Vultr

Cheap, single-box deploy. Run on Ubuntu 24.04 LTS, $12–24/mo plan. No Docker — PM2 + systemd + nginx.

## 1. Provision box

Vultr → Deploy → Cloud Compute → Ubuntu 24.04 → pick region, 1 vCPU / 2 GB RAM minimum. Add your SSH key. Note the IPv4.

## 2. Point DNS

In your DNS provider for `vrtcls.marketing`:

| Type  | Name   | Value                          |
|-------|--------|--------------------------------|
| A     | @      | <your Vultr IPv4>              |
| A     | www    | <your Vultr IPv4>              |

Email records (for deliverability — required before sending):

| Type  | Name   | Value                                                                 |
|-------|--------|-----------------------------------------------------------------------|
| TXT   | @      | `v=spf1 include:_spf.resend.com ~all`                                 |
| TXT   | _dmarc | `v=DMARC1; p=quarantine; rua=mailto:dmarc@vrtcls.marketing; pct=100`  |
| CNAME | resend._domainkey | (value from Resend dashboard → Domains → Add Domain)        |
| CNAME | resend2._domainkey| (value from Resend dashboard)                                |

When you switch to Zapmail, replace the SPF/DKIM records with theirs.

## 3. Base system

```bash
ssh root@<ip>
adduser deploy
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
su - deploy

sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx postgresql postgresql-contrib curl build-essential git ufw

# Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PM2
sudo npm install -g pm2

# Firewall
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
```

## 4. Database

```bash
sudo -u postgres psql -c "CREATE USER vrtcls WITH PASSWORD '<strong-db-pw>';"
sudo -u postgres psql -c "CREATE DATABASE vrtcls OWNER vrtcls;"
```

## 5. App

```bash
cd /home/deploy
git clone git@github.com:jeff-cline/vrtcls-marketing.git app
cd app
npm ci
cp .env.example .env
nano .env   # fill in SESSION_SECRET, DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD,
            # RESEND_API_KEY, BASE_URL=https://vrtcls.marketing,
            # WATTDATA_API_KEY=watt_...   (from https://wattdata.ai/dashboard/api-keys)
npm run migrate
npm run seed

# Start BOTH the web server AND the auto-bake worker
pm2 start ecosystem.config.cjs
pm2 startup systemd   # follow the output instructions
pm2 save
```

**HITT fulfillment** — by default vrtcls runs in **manual mode**:
- A user submits a HITT → admin gets an email ping → admin opens `/admin/hitt`,
  hits **Copy Prompt**, pastes into a claude.ai chat with the WattData
  connector, then pastes the JSON result back and clicks **Fulfill**.
- The customer is auto-emailed "your leads are ready" the moment you fulfill.

**To upgrade to fully-automatic** any time later:
1. Get a WattData API key from https://wattdata.ai/dashboard/api-keys
2. In `.env`, set: `AUTO_BAKE_ENABLED=true` and `WATTDATA_API_KEY=watt_...`
3. `pm2 reload ecosystem.config.cjs` (or restart `vrtcls-worker`)

The worker process polls every ~12s, claims queued HITTs, calls WattData over
HTTP MCP, ingests persons, and flips status to `complete` — no admin in the
loop. Manual `/admin/hitt` always remains as a fallback.

To redeploy after pulling new code:

```bash
cd /home/deploy/app && git pull && npm ci && npm run migrate && pm2 reload ecosystem.config.cjs
```

## 6. Nginx + HTTPS

Create `/etc/nginx/sites-available/vrtcls.marketing`:

```nginx
server {
  server_name vrtcls.marketing www.vrtcls.marketing;
  client_max_body_size 16M;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/vrtcls.marketing /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo snap install --classic certbot
sudo ln -s /snap/bin/certbot /usr/bin/certbot
sudo certbot --nginx -d vrtcls.marketing -d www.vrtcls.marketing --redirect
```

## 7. Verify

- `https://vrtcls.marketing` → landing page
- `https://vrtcls.marketing/login` → log in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`
- `/admin` works
- Create a test user in a different browser → $5 welcome credit lands

## 8. Send email deliverability test

Paste one real lead via `/admin/import`, buy it as a user, send a test. Check:
- Inbox (not spam) on Gmail/Outlook
- `mail-tester.com` score
- Resend dashboard shows delivery

## 9. First lead pull (manual mode — default)

1. A user submits a HITT from `/app` → row inserted with `status='queued'`.
2. You (admin) get an email at `ADMIN_EMAIL` saying "new request from X".
3. Open `https://vrtcls.marketing/admin/hitt`. Each pending request shows a
   **Copy Prompt** button. Click it, switch to claude.ai (with the WattData
   connector authorized), paste the prompt, hit Enter.
4. Claude returns the persons array. Copy it.
5. Back on `/admin/hitt`, paste into the **Persons JSON** box. Leave the
   "Also add to my admin pool" checkbox on. Click **Fulfill HITT**.
6. The customer is auto-emailed "your leads are ready" with a link to
   `/app/leads?hitt_id=N`. Their bake page also auto-redirects on its next poll.

If you can't fulfill (Claude returned nothing, prompt was junk), click
**Mark failed** with an optional note — the customer is emailed too.

## 9b. First lead pull (auto mode — once you have a WattData key)

Set `AUTO_BAKE_ENABLED=true` and `WATTDATA_API_KEY=watt_...` in `.env`,
restart the worker. From then on, queued HITTs are picked up within ~12s,
WattData is called over MCP-over-HTTP, persons are ingested, and the bake
page auto-redirects when complete — no admin in the loop. Manual
`/admin/hitt` always remains available as a fallback.

To watch the worker live:

```bash
pm2 logs vrtcls-worker
```

If a HITT marks `failed` in auto mode, check the `notes` column in
`hitt_requests` — that's the error message from WattData / geocoding / etc.

## Next hardening steps (post-launch)

- Rate limiting on `/login`, `/signup`, `/c/`, `/p/`
- Redis-backed sessions (replace in-memory for multi-process PM2)
- Automated DB backups (`pg_dump` cron → Vultr Object Storage or S3)
- Error monitoring (Sentry)
- Log aggregation (pino → Loki or Datadog)
