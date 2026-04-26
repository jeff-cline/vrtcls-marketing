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
<p>Noticed a lot of folks in {{city}} have been looking into <a href="{{cta_url}}" data-link-key="offer">this</a> lately — thought I'd pass it along in case it helps.</p>
<p>If it's useful, <a href="{{cta_url}}" data-link-key="learn">here's a short overview</a>. If not, no worries — just hit reply and I'll stop.</p>
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
<p>If you're still shopping, there's <a href="{{cta_url}}" data-link-key="compare">a fast comparison here</a>. If you've already picked, <a href="{{cta_url}}" data-link-key="alt">this alternative</a> is saving folks money.</p>
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
<p><a href="{{cta_url}}" data-link-key="guide">Read the guide</a> (no form, just the guide).</p>
<p>If you want the deeper version — <a href="{{cta_url}}" data-link-key="deep">here it is</a>.</p>
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
<p><a href="{{cta_url}}" data-link-key="offer">Here's what they got</a>.</p>
<p>Or if you want to see how it compares, <a href="{{cta_url}}" data-link-key="compare">this page shows the numbers</a>.</p>
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
<p>Straight to it: <a href="{{cta_url}}" data-link-key="offer">this offer</a> is open through the end of the week.</p>
<p>Not for you? <a href="{{cta_url}}" data-link-key="alt">This one</a> might be.</p>
<p>— Jeff</p>
</div>`,
    links: JSON.stringify([
      { key: 'offer', label: 'Primary offer' },
      { key: 'alt', label: 'Alternative' },
    ]),
  },
  // ===========================================================================
  // Persona-aware variants — these reference {{persona_name}} and
  // {{persona_signature}}, so the From-name on the mailbox flows through into
  // the body itself. Pair with a persona on the sending mailbox.
  // ===========================================================================
  {
    slug: 'persona_warm_intro',
    name: 'Persona — Warm intro',
    subject: '{{first_name}} — quick one from {{persona_name}}',
    body_html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#222;">
<p>Hi {{first_name}},</p>
<p>{{persona_name}} here — I help folks in {{city}} who are weighing options on this. Mind if I share a 2-minute overview?</p>
<p><a href="{{cta_url}}" data-link-key="overview" style="display:inline-block;padding:10px 18px;background:#ffc107;color:#000;text-decoration:none;border-radius:4px;font-weight:bold">See the overview</a></p>
<p>If it's not useful just hit reply with "no thanks" and I'll back off.</p>
{{persona_signature}}
</div>`,
    links: JSON.stringify([{ key: 'overview', label: 'Overview' }]),
  },
  {
    slug: 'persona_question',
    name: 'Persona — One question',
    subject: 'A quick question, {{first_name}}',
    body_html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#222;">
<p>Hi {{first_name}},</p>
<p>I'm {{persona_name}}{{persona_title}}. One question — are you actively comparing options right now, or is this a "someday" thing?</p>
<p>If you're actively shopping: <a href="{{cta_url}}" data-link-key="compare">here's a side-by-side that takes 90 seconds</a>.</p>
<p>If it's "someday," say so and I'll send something different.</p>
{{persona_signature}}
</div>`,
    links: JSON.stringify([{ key: 'compare', label: 'Comparison' }]),
  },
  {
    slug: 'persona_local_proof',
    name: 'Persona — Local proof',
    subject: 'Saw {{city}} on my list',
    body_html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#222;">
<p>{{first_name}},</p>
<p>{{persona_name}} here. A handful of folks in {{zip}} signed up last week — figured you'd want to see what they got before the offer changes.</p>
<p><a href="{{cta_url}}" data-link-key="local" style="display:inline-block;padding:10px 18px;background:#212529;color:#fff;text-decoration:none;border-radius:4px;font-weight:bold">See what your neighbors got</a></p>
<p>Worst case it's not for you and you ignore me — no harm done.</p>
{{persona_signature}}
</div>`,
    links: JSON.stringify([{ key: 'local', label: 'Local proof' }]),
  },
  {
    slug: 'persona_resource',
    name: 'Persona — Resource hand-off',
    subject: 'Made this for {{state}} folks like you',
    body_html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#222;">
<p>Hi {{first_name}},</p>
<p>{{persona_name}} again. Put together a one-pager specifically for people in {{state}} who are running into this — no form, no signup, just the page.</p>
<p><a href="{{cta_url}}" data-link-key="guide">Read the one-pager</a></p>
<p>Want the deeper version? <a href="{{cta_url}}" data-link-key="deep">Here it is</a> — same deal, no friction.</p>
{{persona_signature}}
</div>`,
    links: JSON.stringify([
      { key: 'guide', label: 'One-pager' },
      { key: 'deep', label: 'Deep version' },
    ]),
  },
  {
    slug: 'persona_direct_cta',
    name: 'Persona — Direct CTA',
    subject: '{{first_name}}, this expires Friday',
    body_html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#222;">
<p>{{first_name}},</p>
<p>{{persona_name}} — keeping this short. The current offer for {{city}} closes <strong>this Friday</strong>.</p>
<p style="text-align:center;margin:24px 0;">
  <a href="{{cta_url}}" data-link-key="claim" style="display:inline-block;padding:14px 28px;background:#28a745;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;font-size:16px">Claim before Friday</a>
</p>
<p>If now's not the time, hit reply with "later" and I'll check back next month.</p>
{{persona_signature}}
</div>`,
    links: JSON.stringify([{ key: 'claim', label: 'Claim CTA' }]),
  },
];

async function seedTemplates() {
  for (const t of TEMPLATES) {
    // Upsert against the partial unique index on (slug) WHERE owner_user_id IS NULL
    const { rows } = await query(
      'SELECT id FROM email_templates WHERE owner_user_id IS NULL AND slug = $1',
      [t.slug]
    );
    if (rows[0]) {
      await query(
        `UPDATE email_templates
           SET name=$1, subject=$2, body_html=$3, links=$4::jsonb, updated_at=NOW()
         WHERE id=$5`,
        [t.name, t.subject, t.body_html, t.links, rows[0].id]
      );
    } else {
      await query(
        `INSERT INTO email_templates (slug, name, subject, body_html, links, owner_user_id)
         VALUES ($1,$2,$3,$4,$5::jsonb,NULL)`,
        [t.slug, t.name, t.subject, t.body_html, t.links]
      );
    }
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
