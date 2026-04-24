// Zapmail.ai adapter — STUB.
// Fill in once we have the API key + docs URL from the user.
//
// Expected shape once wired:
//   const client = createZapmailClient(apiKey);
//   await client.send({ from, to, subject, html, reply_to });
//
// Env vars:
//   ZAPMAIL_API_KEY          — auth token
//   ZAPMAIL_ACCOUNTS         — comma-separated sender identities (for 50/day rotation, Phase 3)
//
// Until docs are in hand, calling sendViaZapmail throws so the dev can't silently fall back.

export function createZapmailClient(apiKey) {
  if (!apiKey) throw new Error('ZAPMAIL_API_KEY not set');
  return {
    async send({ from, to, subject, html, replyTo }) {
      throw new Error(
        'zapmail.send not yet wired — need API docs/endpoint from vendor'
      );
    },
  };
}

export async function sendViaZapmail(opts) {
  const client = createZapmailClient(process.env.ZAPMAIL_API_KEY);
  return client.send(opts);
}
