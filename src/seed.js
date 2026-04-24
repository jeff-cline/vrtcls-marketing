import { config } from './config.js';
import { pool, query } from './db.js';
import { hashPassword } from './auth.js';

const TEMPLATES = [
  {
    slug: 'soft_intro',
    name: 'Soft Intro',
    subject: 'Quick note for {{first_name}}',
    body_html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#222;">
<p>Hi {{first_name}},</p>
<p>Noticed a lot of folks in {{city}} have been looking into <a href="https://vrtcls.marketing/offer" data-link-key="offer">this</a> lately — thought I'd pass it along in case it helps.</p>
<p>If it's useful, <a href="https://vrtcls.marketing/learn" data-link-key="learn">here's a short overview</a>. If not, no worries — just hit reply and I'll stop.</p>
<p>— Jeff</p>
</div>`,
    links: JSON.stringify([
      { key: 'offer', label: 'Primary offer' },
      { key: 'learn', label: 'Learn more' },
    ]),
  },
  {
    slug: 'question_hook',
    name: 'Question Hook',
    subject: 'A question, {{first_name}}',
    body_html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#222;">
<p>Hi {{first_name}},</p>
<p>Quick question — are you still comparing options on this, or already decided?</p>
<p>If you're still shopping, there's <a href="https://vrtcls.marketing/compare" data-link-key="compare">a fast comparison here</a>. If you've already picked, <a href="https://vrtcls.marketing/alt" data-link-key="alt">this alternative</a> is saving folks money.</p>
<p>Either way, happy to help.</p>
<p>— Jeff</p>
</div>`,
    links: JSON.stringify([
      { key: 'compare', label: 'Comparison guide' },
      { key: 'alt', label: 'Alternative offer' },
    ]),
  },
  {
    slug: 'useful_resource',
    name: 'Useful Resource',
    subject: 'For {{first_name}} in {{state}}',
    body_html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#222;">
<p>Hi {{first_name}},</p>
<p>Put together a short guide that's been helping people in {{state}} get clearer on options:</p>
<p><a href="https://vrtcls.marketing/guide" data-link-key="guide">Read the guide</a> (no form, just the guide).</p>
<p>If you want the deeper version — <a href="https://vrtcls.marketing/deep" data-link-key="deep">here it is</a>.</p>
<p>— Jeff</p>
</div>`,
    links: JSON.stringify([
      { key: 'guide', label: 'Short guide' },
      { key: 'deep', label: 'Deep version' },
    ]),
  },
  {
    slug: 'peer_proof',
    name: 'Peer Proof',
    subject: '{{city}} neighbors',
    body_html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#222;">
<p>Hi {{first_name}},</p>
<p>A handful of people in {{zip}} signed up last month — figured you'd want to see it too.</p>
<p><a href="https://vrtcls.marketing/offer" data-link-key="offer">Here's what they got</a>.</p>
<p>Or if you want to see how it compares, <a href="https://vrtcls.marketing/compare" data-link-key="compare">this page shows the numbers</a>.</p>
<p>— Jeff</p>
</div>`,
    links: JSON.stringify([
      { key: 'offer', label: 'Offer' },
      { key: 'compare', label: 'Comparison' },
    ]),
  },
  {
    slug: 'direct_offer',
    name: 'Direct Offer',
    subject: 'For you, {{first_name}}',
    body_html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#222;">
<p>{{first_name}},</p>
<p>Straight to it: <a href="https://vrtcls.marketing/offer" data-link-key="offer">this offer</a> is open through the end of the week.</p>
<p>Not for you? <a href="https://vrtcls.marketing/alt" data-link-key="alt">This one</a> might be.</p>
<p>— Jeff</p>
</div>`,
    links: JSON.stringify([
      { key: 'offer', label: 'Primary offer' },
      { key: 'alt', label: 'Alternative' },
    ]),
  },
];

async function seedTemplates() {
  for (const t of TEMPLATES) {
    await query(
      `INSERT INTO email_templates (slug, name, subject, body_html, links)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name,
         subject = EXCLUDED.subject,
         body_html = EXCLUDED.body_html,
         links = EXCLUDED.links`,
      [t.slug, t.name, t.subject, t.body_html, t.links]
    );
  }
  console.log(`seeded ${TEMPLATES.length} templates`);
}

async function seedAdmin() {
  if (!config.admin.email || !config.admin.password) {
    console.log('admin env vars not set — skipping admin seed');
    return;
  }
  const email = config.admin.email.toLowerCase().trim();
  const hash = await hashPassword(config.admin.password);
  await query(
    `INSERT INTO users (email, password_hash, role, credits_cents)
     VALUES ($1, $2, 'admin', 100000)
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash,
       role = 'admin'`,
    [email, hash]
  );
  console.log(`seeded admin: ${email}`);
}

async function run() {
  await seedTemplates();
  await seedAdmin();
  await pool.end();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
