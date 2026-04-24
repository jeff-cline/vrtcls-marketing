import { tx } from '../db.js';
import { priceForAge, TOKENS_PER_LEAD } from './pricing.js';

export async function grantCredits(userId, deltaCents, reason, createdBy) {
  return tx(async (client) => {
    await client.query(
      'UPDATE users SET credits_cents = credits_cents + $1 WHERE id = $2',
      [deltaCents, userId]
    );
    await client.query(
      'INSERT INTO credit_ledger (user_id, delta_cents, reason, created_by) VALUES ($1,$2,$3,$4)',
      [userId, deltaCents, reason, createdBy]
    );
  });
}

export async function grantTokens(userId, delta, reason, refId = null, client = null) {
  const run = async (c) => {
    await c.query('UPDATE users SET email_tokens = email_tokens + $1 WHERE id = $2', [delta, userId]);
    await c.query(
      'INSERT INTO token_ledger (user_id, delta, reason, ref_id) VALUES ($1,$2,$3,$4)',
      [userId, delta, reason, refId]
    );
  };
  if (client) return run(client);
  return tx(run);
}

export async function consumeToken(userId, reason, refId, client) {
  const res = await client.query(
    'UPDATE users SET email_tokens = email_tokens - 1 WHERE id = $1 AND email_tokens > 0 RETURNING email_tokens',
    [userId]
  );
  if (res.rowCount === 0) {
    const err = new Error('Insufficient tokens');
    err.code = 'NO_TOKENS';
    throw err;
  }
  await client.query(
    'INSERT INTO token_ledger (user_id, delta, reason, ref_id) VALUES ($1,-1,$2,$3)',
    [userId, reason, refId]
  );
}

export async function purchaseLead(userId, leadId) {
  return tx(async (client) => {
    const { rows: leadRows } = await client.query(
      'SELECT id, first_seen FROM leads WHERE id = $1 FOR UPDATE',
      [leadId]
    );
    const lead = leadRows[0];
    if (!lead) throw new Error('Lead not found');

    const { rows: dupe } = await client.query(
      'SELECT 1 FROM lead_purchases WHERE user_id = $1 AND lead_id = $2',
      [userId, leadId]
    );
    if (dupe.length) {
      const err = new Error('Already purchased');
      err.code = 'ALREADY_PURCHASED';
      throw err;
    }

    const tier = priceForAge(lead.first_seen);

    const { rows: userRows } = await client.query(
      'SELECT credits_cents FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    if (!userRows[0] || userRows[0].credits_cents < tier.priceCents) {
      const err = new Error('Insufficient credits');
      err.code = 'NO_CREDITS';
      throw err;
    }

    await client.query(
      'UPDATE users SET credits_cents = credits_cents - $1 WHERE id = $2',
      [tier.priceCents, userId]
    );
    await client.query(
      'INSERT INTO credit_ledger (user_id, delta_cents, reason) VALUES ($1, -$2, $3)',
      [userId, tier.priceCents, `lead_purchase:${leadId}`]
    );

    const { rows: purchase } = await client.query(
      `INSERT INTO lead_purchases (user_id, lead_id, price_cents, tier_days, tokens_granted)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [userId, leadId, tier.priceCents, Number.isFinite(tier.maxDays) ? tier.maxDays : 999, TOKENS_PER_LEAD]
    );

    await grantTokens(userId, TOKENS_PER_LEAD, `lead_purchase:${leadId}`, purchase[0].id, client);

    return { purchase: purchase[0], tier };
  });
}
