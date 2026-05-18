/**
 * POST /api/create-checkout-session
 *
 * Called from the storefront theme when the shopper clicks "Checkout".
 * Body = the raw Shopify /cart.js JSON (currency + items[]).
 *
 * Builds a Stripe Checkout Session with inline price_data (no need to
 * pre-create products in Stripe) and returns { url } so the theme can
 * redirect the browser to the Stripe-hosted payment page.
 *
 * The order is NOT created here. It is created by api/stripe-webhook.js
 * when Stripe confirms payment — that is the single source of truth, so
 * a paid order always lands in Shopify even if the shopper closes the tab.
 */

const Stripe = require('stripe');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2025-09-30.clover',
});

const CURRENCY = (process.env.CURRENCY || 'eur').toLowerCase();
const STORE_URL = (process.env.STORE_URL || 'https://your-store.example').replace(/\/$/, '');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || STORE_URL)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Stripe metadata values are capped at 500 chars. We only stash the
// minimum the webhook needs to rebuild the Shopify order: [variantId, qty].
const METADATA_MAX = 500;

// Replicates the store's Shopify shipping rates. NOTE: hosted Stripe
// Checkout shows the SAME options regardless of the address entered (it
// doesn't recompute per zone like Shopify), so all rates are listed with
// a zone hint and the shopper picks. Max 5 options.
const SHIPPING_OPTIONS = [
  ['Envío estándar gratuito (España)', 0],
  ['Envío estándar (España)', 500],
  ['Envío Premium con seguro (España)', 650],
  ['Estándar Internacional · UE', 899],
  ['Estándar Internacional', 1299],
].map(([display_name, amount]) => ({
  shipping_rate_data: {
    type: 'fixed_amount',
    display_name,
    fixed_amount: { amount, currency: CURRENCY },
  },
}));

// Union of the store's Shopify shipping-zone countries (España + UE + Intl).
const ALLOWED_COUNTRIES = ['AE','AT','AU','BE','BG','CA','CH','CY','CZ','DE','DK','EE','ES','FI','FR','GB','GR','HK','HR','HU','IE','IL','IT','JP','KR','LT','LU','LV','MT','MY','NL','NO','NZ','PL','PT','RO','SE','SG','SI','SK','US'];

// Optional ecommerce fields collected on the Stripe page.
const CUSTOM_FIELDS = [
  {
    key: 'nif',
    label: { type: 'custom', custom: 'NIF / CIF (para factura)' },
    type: 'text',
    optional: true,
  },
  {
    key: 'notas',
    label: { type: 'custom', custom: 'Notas de entrega' },
    type: 'text',
    optional: true,
  },
];

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

module.exports = async (req, res) => {
  applyCors(req, res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const cart = await readJsonBody(req);
    const items = Array.isArray(cart.items) ? cart.items : [];

    if (items.length === 0) {
      return res.status(400).json({ error: 'El carrito está vacío.' });
    }

    const lineItems = items.map((item) => {
      const name = item.variant_title
        ? `${item.product_title} — ${item.variant_title}`
        : item.product_title || item.title || 'Producto';

      const product_data = { name };
      // Stripe only accepts publicly reachable https images.
      if (item.image && /^https:\/\//.test(item.image)) {
        product_data.images = [item.image.split('?')[0]];
      }
      product_data.metadata = {
        shopify_variant_id: String(item.id),
        sku: item.sku || '',
      };

      return {
        quantity: item.quantity,
        price_data: {
          currency: CURRENCY,
          // Shopify cart.js prices are integer cents — same unit as Stripe.
          unit_amount: item.final_price,
          product_data,
        },
      };
    });

    // Compact map the webhook uses to recreate the order: [[variantId, qty], ...]
    const compact = JSON.stringify(items.map((i) => [i.id, i.quantity]));
    if (compact.length > METADATA_MAX) {
      return res.status(400).json({
        error:
          'Carrito demasiado grande para esta prueba (demasiadas líneas distintas). Reduce el número de productos.',
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      locale: 'es',
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: true },
      shipping_address_collection: { allowed_countries: ALLOWED_COUNTRIES },
      shipping_options: SHIPPING_OPTIONS,
      custom_fields: CUSTOM_FIELDS,
      success_url: `${STORE_URL}/pages/gracias?sid={CHECKOUT_SESSION_ID}`,
      cancel_url: `${STORE_URL}/cart`,
      metadata: {
        source: 'storefront',
        cart_token: cart.token || '',
        shopify_line_items: compact,
      },
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[create-checkout-session]', err);
    return res
      .status(500)
      .json({ error: 'No se pudo iniciar el pago. Inténtalo de nuevo.' });
  }
};
