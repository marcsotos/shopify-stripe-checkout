/**
 * POST /api/stripe-webhook
 *
 * Stripe → here, when a Checkout Session is paid.
 * Verifies the Stripe signature, then recreates the order in Shopify
 * (financial_status: paid) and decrements stock.
 *
 * This is the single source of truth for "an order happened": it fires
 * server-to-server, so the order lands in Shopify even if the shopper
 * closes the browser on the Stripe success page.
 *
 * Idempotent: orders are tagged with the Stripe session id and we skip
 * if one already exists, so Stripe retries can't double-charge stock.
 */

const Stripe = require('stripe');
const {
  orderExistsForSession,
  createOrder,
  isExcludedSpanishCP,
} = require('../lib/shopify');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-09-30.clover',
});
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Stripe signature is computed over the raw body — Vercel must NOT parse it.
module.exports.config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function splitName(full) {
  const parts = (full || '').trim().split(/\s+/);
  if (parts.length <= 1) return { first_name: full || '', last_name: '' };
  return { first_name: parts[0], last_name: parts.slice(1).join(' ') };
}

/** Stripe address shape → Shopify address shape. */
function toShopifyAddress(stripeAddr, name, phone) {
  if (!stripeAddr) return null;
  const { first_name, last_name } = splitName(name);
  return {
    first_name,
    last_name,
    address1: stripeAddr.line1 || '',
    address2: stripeAddr.line2 || '',
    city: stripeAddr.city || '',
    province: stripeAddr.state || '',
    zip: stripeAddr.postal_code || '',
    country_code: stripeAddr.country || '',
    phone: phone || '',
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let event;
  try {
    const raw = await readRawBody(req);
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(raw, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('[stripe-webhook] signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature error` });
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, ignored: event.type });
  }

  const session = event.data.object;

  try {
    if (session.payment_status !== 'paid') {
      console.log(`[stripe-webhook] session ${session.id} not paid, skipping`);
      return res.status(200).json({ received: true, skipped: 'unpaid' });
    }

    // Idempotency guard — Stripe retries on any non-2xx.
    if (await orderExistsForSession(session.id)) {
      console.log(`[stripe-webhook] order for ${session.id} already exists`);
      return res.status(200).json({ received: true, duplicate: true });
    }

    // Rebuild line items from the compact map we stored at session creation.
    let compact;
    try {
      compact = JSON.parse(session.metadata?.shopify_line_items || '[]');
    } catch {
      compact = [];
    }
    if (!Array.isArray(compact) || compact.length === 0) {
      // Unrecoverable (bad/missing metadata) — 200 so Stripe stops retrying.
      console.error(
        `[stripe-webhook] no usable line items in metadata for ${session.id}`
      );
      return res.status(200).json({ received: true, error: 'no line items' });
    }
    const lineItems = compact.map(([variant_id, quantity]) => ({
      variant_id,
      quantity,
    }));

    const details = session.customer_details || {};
    const shipping =
      session.collected_information?.shipping_details ||
      session.shipping_details ||
      null;

    const shippingAddress = toShopifyAddress(
      shipping?.address || details.address,
      shipping?.name || details.name,
      details.phone
    );
    const billingAddress = toShopifyAddress(
      details.address,
      details.name,
      details.phone
    );

    // Re-fetch with the shipping rate expanded so we can label the
    // shipping line and read the custom fields (NIF / delivery notes).
    let full = session;
    try {
      full = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['shipping_cost.shipping_rate'],
      });
    } catch (e) {
      console.error('[stripe-webhook] session retrieve failed (non-fatal):', e.message);
    }

    // Layer 2 safety net: if the real shipping address is an excluded
    // Spanish region (slipped past the cart check), refund and do NOT
    // create an unfulfillable order.
    const shipAddr =
      full.collected_information?.shipping_details?.address ||
      full.customer_details?.address ||
      shipping?.address ||
      details.address ||
      {};
    if (
      String(shipAddr.country || '').toUpperCase() === 'ES' &&
      isExcludedSpanishCP(shipAddr.postal_code)
    ) {
      try {
        const pi = full.payment_intent || session.payment_intent;
        if (pi) {
          await stripe.refunds.create({
            payment_intent: typeof pi === 'string' ? pi : pi.id,
          });
        }
      } catch (e) {
        console.error(
          '[stripe-webhook] auto-refund failed (refund manually):',
          e.message
        );
      }
      console.warn(
        `[stripe-webhook] excluded region CP ${shipAddr.postal_code} — refunded, no order for ${session.id}`
      );
      return res
        .status(200)
        .json({ received: true, refused: 'excluded-region', refunded: true });
    }

    const shippingLines = [];
    if (full.shipping_cost && full.shipping_cost.amount_total != null) {
      const rate = full.shipping_cost.shipping_rate;
      shippingLines.push({
        title:
          (rate && typeof rate === 'object' && rate.display_name) || 'Envío',
        price: (full.shipping_cost.amount_total / 100).toFixed(2),
      });
    }

    const noteAttributes = [];
    for (const cf of full.custom_fields || []) {
      const value = cf.text && cf.text.value;
      if (!value) continue;
      if (cf.key === 'nif') noteAttributes.push({ name: 'NIF/CIF', value });
      if (cf.key === 'notas')
        noteAttributes.push({ name: 'Notas de entrega', value });
    }

    const order = await createOrder({
      sessionId: session.id,
      lineItems,
      email: details.email,
      amountTotal: session.amount_total,
      currency: session.currency,
      customer: {
        ...splitName(details.name),
        phone: details.phone,
      },
      shippingAddress,
      billingAddress,
      shippingLines,
      noteAttributes,
    });

    // Stamp the Stripe session with the order's status page so the
    // confirmation page can forward instantly (no Shopify tag-search lag).
    try {
      await stripe.checkout.sessions.update(session.id, {
        metadata: {
          shopify_order: order.name,
          shopify_order_status_url: order.order_status_url || '',
        },
      });
    } catch (e) {
      console.error('[stripe-webhook] metadata stamp failed (non-fatal):', e.message);
    }

    console.log(
      `[stripe-webhook] created Shopify order ${order.name} (#${order.id}) for ${session.id}`
    );
    return res.status(200).json({ received: true, order: order.name });
  } catch (err) {
    // Transient (Shopify API hiccup) — 500 so Stripe retries the webhook.
    console.error('[stripe-webhook] order creation failed:', err);
    return res.status(500).json({ error: 'order creation failed' });
  }
};
