/**
 * GET /api/order-status?sid=cs_test_...
 *
 * Polled by the post-payment confirmation page. Returns whether the order
 * for this checkout session has been created yet and the native Shopify
 * order-status page URL to forward the shopper to.
 *
 * Primary source: the Stripe session metadata, which the webhook stamps
 * with the order status URL the instant the order is created (no Shopify
 * tag-search indexing lag). Fallback: Shopify tag search, in case the
 * metadata stamp failed.
 *
 *   { ready: false }
 *   { ready: true, name: "#1008", statusUrl: "https://.../orders/..." }
 */

const Stripe = require('stripe');
const { getOrderStatusForSession } = require('../lib/shopify');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-09-30.clover',
});

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

  res.setHeader('Cache-Control', 'no-store');

  // Primary: Stripe session metadata (instant once the webhook ran).
  try {
    const session = await stripe.checkout.sessions.retrieve(sid);
    const url = session?.metadata?.shopify_order_status_url;
    if (url) {
      return res.status(200).json({
        ready: true,
        name: session.metadata.shopify_order || '',
        statusUrl: url,
      });
    }
  } catch (e) {
    /* unknown/garbage sid, or Stripe hiccup — fall through */
  }

  // Fallback: Shopify tag search (covers a failed metadata stamp).
  try {
    const status = await getOrderStatusForSession(sid);
    return res.status(200).json(status);
  } catch (err) {
    console.error('[order-status]', err);
    return res.status(200).json({ ready: false });
  }
};
