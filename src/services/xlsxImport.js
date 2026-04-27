import xlsx from 'xlsx';
import crypto from 'node:crypto';
import { tx } from '../db.js';

// Convert an xlsx Buffer (uploaded by an admin) into a list of person-shaped
// rows compatible with leads/audience_leads inserts. We don't try to be clever
// — we look for columns whose names match a small set of synonyms, and we
// generate a stable person_id by hashing email + name when none is provided.
export function parseLeadsXlsx(buf) {
  const wb = xlsx.read(buf, { type: 'buffer' });
  const out = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows = xlsx.utils.sheet_to_json(ws, { defval: '', raw: false });
    if (!rows.length) continue;
    const sample = rows[0];
    if (!hasContactColumns(sample)) continue;
    for (const row of rows) {
      const person = rowToPerson(row, name);
      if (!person) continue;
      out.push(person);
    }
    if (out.length) break;
  }
  return out;
}

function hasContactColumns(row) {
  const keys = Object.keys(row).map((k) => k.toLowerCase());
  const hasName = keys.some((k) => k === 'full name' || k === 'name' || k === 'first name' || k === 'firstname' || k === 'first_name');
  const hasEmail = keys.some((k) => k === 'email' || k === 'emails' || k === 'e-mail' || k === 'email address');
  return hasName || hasEmail;
}

function get(row, ...keys) {
  for (const k of keys) {
    for (const rk of Object.keys(row)) {
      if (rk.toLowerCase().trim() === k.toLowerCase()) {
        const v = row[rk];
        if (v != null && String(v).trim() !== '') return String(v).trim();
      }
    }
  }
  return null;
}

function rowToPerson(row) {
  const fullName = get(row, 'Full Name', 'Name');
  let firstName = get(row, 'First Name', 'FirstName', 'first_name');
  let lastName  = get(row, 'Last Name', 'LastName', 'last_name', 'Surname');
  if (!firstName && fullName) {
    const parts = fullName.split(/\s+/);
    firstName = parts[0];
    lastName  = parts.slice(1).join(' ') || null;
  }

  const emailsRaw = get(row, 'Emails', 'Email', 'E-mail', 'Email Address');
  const emailList = (emailsRaw || '')
    .split(/[;,]/)
    .map((e) => e.trim())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
  const email = emailList[0] || null;

  if (!email && !firstName) return null;

  const phone = get(row, 'Phone', 'Phone Number', 'OK to Call', 'Mobile');
  // The "Do Not Call" column is phone-DNC, not email-DNC — don't block email
  // sends from a phone list. Only honor an explicit email-DNC signal.
  const dnc = !!get(row, 'Email DNC', 'Do Not Email', 'Email Suppress');

  const address = {
    line1:  get(row, 'Address', 'Street', 'Address Line 1') || null,
    city:   get(row, 'City') || null,
    state:  get(row, 'State') || null,
    zip:    get(row, 'ZIP', 'Zip', 'Postal Code') || null,
    county: get(row, 'County') || null,
  };
  const hasAddress = address.line1 || address.city || address.state || address.zip;

  const tier = get(row, 'Net Worth Tier', 'Tier', 'Segment');
  const tags = [];
  if (tier) tags.push(slug(tier));
  const rank = get(row, 'Rank');

  const seed = `${email || ''}|${firstName || ''}|${lastName || ''}|${address.zip || ''}`;
  const personId = 'xlsx_' + crypto.createHash('md5').update(seed).digest('hex').slice(0, 16);

  return {
    person_id: personId,
    email,
    phone,
    first_name: firstName,
    last_name: lastName,
    address: hasAddress ? address : null,
    dnc,
    tags,
    extra: {
      rank: rank ? Number(rank) || rank : null,
      net_worth_tier: tier || null,
      household_net_worth: get(row, 'Household Net Worth') || null,
      household_income: get(row, 'Household Income') || null,
      individual_income: get(row, 'Individual Income') || null,
      credit_rating: get(row, 'Credit Rating') || null,
      all_emails: emailList,
    },
  };
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

export async function ingestXlsxPersons({ persons, importedBy, audienceLabel, extraTag }) {
  return tx(async (client) => {
    const { rows: aud } = await client.query(
      `INSERT INTO audiences (workflow_id, tool_trace_id, total_count, imported_by)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [audienceLabel || null, null, persons.length, importedBy || null]
    );
    const audienceId = aud[0].id;
    let inserted = 0, updated = 0;
    const baseTag = extraTag ? slug(extraTag) : null;

    for (const p of persons) {
      const { rows: existing } = await client.query(
        'SELECT id FROM leads WHERE person_id = $1', [p.person_id]
      );
      let leadId;
      if (existing[0]) {
        leadId = existing[0].id;
        await client.query(
          `UPDATE leads SET
             email=COALESCE($2,email), phone=COALESCE($3,phone),
             first_name=COALESCE($4,first_name), last_name=COALESCE($5,last_name),
             address=COALESCE($6,address), dnc=COALESCE($7,dnc),
             last_seen=NOW() WHERE id=$1`,
          [leadId, p.email, p.phone, p.first_name, p.last_name,
           p.address ? JSON.stringify(p.address) : null, p.dnc]
        );
        updated++;
      } else {
        const { rows: ins } = await client.query(
          `INSERT INTO leads (person_id, email, phone, first_name, last_name, address, dnc)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [p.person_id, p.email, p.phone, p.first_name, p.last_name,
           p.address ? JSON.stringify(p.address) : null, p.dnc]
        );
        leadId = ins[0].id;
        inserted++;
      }
      await client.query(
        'INSERT INTO audience_leads (audience_id, lead_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [audienceId, leadId]
      );
      const tagSet = new Set([...(p.tags || [])]);
      if (baseTag) tagSet.add(baseTag);
      for (const tag of tagSet) {
        if (!tag) continue;
        await client.query(
          `INSERT INTO lead_tags (lead_id, tag, source) VALUES ($1, $2, $3)
           ON CONFLICT (lead_id, tag) DO NOTHING`,
          [leadId, tag, `xlsx:${audienceId}`]
        );
      }
    }
    return { audienceId, total: persons.length, inserted, updated };
  });
}
