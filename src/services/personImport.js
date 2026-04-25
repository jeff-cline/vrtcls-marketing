import { tx } from '../db.js';

function pickEmail(p) {
  if (typeof p.email === 'string') return p.email;
  const ids = p.identifiers || {};
  const emails = Array.isArray(ids.emails) ? ids.emails : (Array.isArray(p.emails) ? p.emails : []);
  const optedIn = emails.find((e) => e && e.opted_in === true && e.email_address);
  if (optedIn) return optedIn.email_address;
  const any = emails.find((e) => e && e.email_address);
  if (any) return any.email_address;
  const flat = emails.find((e) => typeof e === 'string');
  return flat || null;
}

function pickPhone(p) {
  if (typeof p.phone === 'string') return p.phone;
  const ids = p.identifiers || {};
  const phones = Array.isArray(ids.phones) ? ids.phones : (Array.isArray(p.phones) ? p.phones : []);
  const cell = phones.find((ph) => ph && ph.phone_type === 'cell' && ph.do_not_call === false && ph.phone_number);
  if (cell) return cell.phone_number;
  const ok = phones.find((ph) => ph && ph.do_not_call === false && ph.phone_number);
  if (ok) return ok.phone_number;
  const any = phones.find((ph) => ph && ph.phone_number);
  return any ? any.phone_number : null;
}

function flatten(p) {
  const ids = p.identifiers || {};
  const names = Array.isArray(ids.names) ? ids.names : [];
  const addresses = Array.isArray(ids.addresses) ? ids.addresses : [];
  const phones = Array.isArray(ids.phones) ? ids.phones : (Array.isArray(p.phones) ? p.phones : []);
  const emails = Array.isArray(ids.emails) ? ids.emails : (Array.isArray(p.emails) ? p.emails : []);
  const allPhonesDnc = phones.length > 0 && phones.every((ph) => ph && ph.do_not_call === true);
  const noOptIn = emails.length === 0 || emails.every((e) => !e || e.opted_in === false);
  return {
    person_id: p.person_id || p.id,
    email: pickEmail(p),
    phone: pickPhone(p),
    first_name: p.first_name || (names[0] && names[0].first_name) || null,
    last_name: p.last_name || (names[0] && names[0].last_name) || null,
    address: p.address || (addresses[0] ? {
      line1: addresses[0].address_primary || null,
      line2: addresses[0].address_secondary || null,
      city: addresses[0].city || null,
      state: addresses[0].state || null,
      zip: addresses[0].zip || null,
      county: addresses[0].county || null,
      lat: addresses[0].latitude || null,
      lng: addresses[0].longitude || null
    } : null),
    dnc: p.dnc === true || (allPhonesDnc && noOptIn)
  };
}

export async function ingestPersons({ hittId, persons, workflowId, toolTraceId, label, importedBy }) {
  return tx(async (client) => {
    const { rows: aud } = await client.query(
      `INSERT INTO audiences (workflow_id, tool_trace_id, total_count, imported_by, hitt_request_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [workflowId || null, toolTraceId || null, persons.length, importedBy || null, hittId]
    );
    const audienceId = aud[0].id;
    let inserted = 0;
    const tag = (label || `hitt_${hittId}`).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');

    for (const raw of persons) {
      const p = flatten(raw);
      if (!p.person_id) continue;
      const { rows: existing } = await client.query(
        'SELECT id FROM leads WHERE person_id = $1', [String(p.person_id)]
      );
      let leadId;
      if (existing[0]) {
        leadId = existing[0].id;
        await client.query(
          `UPDATE leads SET email=COALESCE($2,email), phone=COALESCE($3,phone),
            first_name=COALESCE($4,first_name), last_name=COALESCE($5,last_name),
            address=COALESCE($6,address), last_seen=NOW() WHERE id=$1`,
          [leadId, p.email, p.phone, p.first_name, p.last_name,
           p.address ? JSON.stringify(p.address) : null]
        );
      } else {
        const { rows: ins } = await client.query(
          `INSERT INTO leads (person_id, email, phone, first_name, last_name, address, dnc)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [String(p.person_id), p.email, p.phone, p.first_name, p.last_name,
           p.address ? JSON.stringify(p.address) : null, p.dnc]
        );
        leadId = ins[0].id;
        inserted++;
      }
      await client.query(
        'INSERT INTO audience_leads (audience_id, lead_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [audienceId, leadId]
      );
      if (tag) {
        await client.query(
          `INSERT INTO lead_tags (lead_id, tag, source) VALUES ($1, $2, $3)
           ON CONFLICT (lead_id, tag) DO NOTHING`,
          [leadId, tag, `hitt:${hittId}`]
        );
      }
    }

    await client.query(
      `UPDATE hitt_requests SET status='complete', audience_id=$1, result_count=$2, completed_at=NOW()
       WHERE id=$3`,
      [audienceId, persons.length, hittId]
    );

    return { audienceId, total: persons.length, inserted };
  });
}
