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

// Store's Shopify shipping rates, split by zone. The cart sends the chosen
// zone (ES | EU | INTL) so the Stripe page shows ONLY that zone's rates and
// only that zone's countries — effectively dynamic shipping with hosted
// Checkout (which can't recompute per-address itself).
const ZONES = {
  ES: {
    countries: ['ES'],
    rates: [
      ['Envío estándar gratuito', 0],
      ['Envío estándar', 500],
      ['Envío Premium con seguro', 650],
    ],
  },
  EU: {
    countries: ['AT','BE','BG','CY','CZ','DE','DK','EE','FI','FR','GR','HR','HU','IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK'],
    rates: [['Estándar Internacional · UE', 899]],
  },
  INTL: {
    countries: ['AE','AU','CA','CH','GB','HK','IL','JP','KR','MY','NO','NZ','SG','US'],
    rates: [['Estándar Internacional', 1299]],
  },
};

// Free shipping unlocks at this product subtotal (cents, after discounts).
const FREE_SHIPPING_MIN = 5000; // 50,00 € (inclusive)

function shippingFor(zoneKey, subtotalCents) {
  const zone = ZONES[zoneKey] || ZONES.ES;
  // Hide any free (0 €) rate until the subtotal reaches the threshold.
  let rates = zone.rates.filter(
    ([, amount]) => amount > 0 || subtotalCents >= FREE_SHIPPING_MIN
  );
  if (rates.length === 0) rates = zone.rates; // never leave 0 options
  return {
    allowed_countries: zone.countries,
    shipping_options: rates.map(([display_name, amount]) => ({
      shipping_rate_data: {
        type: 'fixed_amount',
        display_name,
        fixed_amount: { amount, currency: CURRENCY },
      },
    })),
  };
}

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

    // Product subtotal (cents, after discounts, no shipping) for the
    // free-shipping threshold. Prefer Shopify's cart.total_price.
    const subtotalCents = Number.isFinite(cart.total_price)
      ? cart.total_price
      : items.reduce(
          (s, i) =>
            s +
            (Number.isFinite(i.final_line_price)
              ? i.final_line_price
              : (i.final_price || 0) * (i.quantity || 1)),
          0
        );

    // Zone chosen in the cart ("ES" | "EU" | "INTL"); defaults to España.
    const zoneKey = String(cart.ship_zone || 'ES').toUpperCase();
    const { allowed_countries, shipping_options } = shippingFor(
      zoneKey,
      subtotalCents
    );

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      locale: 'es',
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: true },
      shipping_address_collection: { allowed_countries },
      shipping_options,
      custom_fields: CUSTOM_FIELDS,
      success_url: `${STORE_URL}/pages/gracias?sid={CHECKOUT_SESSION_ID}`,
      cancel_url: `${STORE_URL}/cart`,
      metadata: {
        source: 'storefront',
        cart_token: cart.token || '',
        ship_zone: zoneKey,
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
