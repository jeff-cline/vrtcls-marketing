// Lead age → price tiers.
// ≤1 day old:  $5.00
// ≤7 days:     $2.50
// ≤30 days:    $1.00
// >30 days:    $0.50 (old inventory)
const DAY_MS = 24 * 60 * 60 * 1000;

export const TIERS = [
  { maxDays: 1,  priceCents: 500, label: 'Fresh (≤24h)' },
  { maxDays: 7,  priceCents: 250, label: 'This week' },
  { maxDays: 30, priceCents: 100, label: 'This month' },
  { maxDays: Infinity, priceCents: 50, label: 'Archive' },
];

export const TOKENS_PER_LEAD = 5;

// Marketing claim: each unconverted lead is roughly $333 in missed pipeline.
// Used for the "MISSING REVENUE OPPORTUNITY" callout on the lead marketplace.
export const MISSING_OPP_PER_LEAD_CENTS = 33300;

export function ageDays(firstSeen, now = Date.now()) {
  const t = firstSeen instanceof Date ? firstSeen.getTime() : new Date(firstSeen).getTime();
  return (now - t) / DAY_MS;
}

export function priceForAge(firstSeen, now = Date.now()) {
  const days = ageDays(firstSeen, now);
  for (const tier of TIERS) {
    if (days <= tier.maxDays) return { ...tier, ageDays: days };
  }
  return { ...TIERS[TIERS.length - 1], ageDays: days };
}
