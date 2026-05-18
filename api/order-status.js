/**
 * GET /api/order-status?sid=cs_test_...
 *
 * Polled by the post-payment confirmation page. Returns whether the order
 * for this checkout session has been created yet (the webhook creates it
 * a beat after the shopper is redirected back), plus the native Shopify
 * order-status page URL to forward them to.
 *
 *   { ready: false }
 *   { ready: true, name: "#1008", statusUrl: "https://.../orders/..." }
 */

const { getOrderStatusForSession } = require('../lib/shopify');

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || process.env.STORE_URL || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sid =
    (req.query && req.query.sid) ||
    new URL(req.url, 'http://x').searchParams.get('sid');

  if (!sid) return res.status(400).json({ error: 'missing sid' });

  try {
    const status = await getOrderStatusForSession(sid);
    // Don't let the browser/CDN cache a transient "not ready yet".
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(status);
  } catch (err) {
    console.error('[order-status]', err);
    return res.status(200).json({ ready: false });
  }
};
