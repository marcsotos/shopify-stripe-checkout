/**
 * Shopify Admin API helpers.
 *
 * - orderExistsForSession(): idempotency guard. Every order we create is
 *   tagged `stripe-session-<id>`; before creating we search by that tag so
 *   Stripe webhook retries never produce duplicate orders. No DB needed.
 * - createOrder(): REST create with inventory_behaviour decrement so stock
 *   drops exactly like a normal Shopify order.
 */

const DOMAIN = process.env.SHOPIFY_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

function sessionTag(sessionId) {
  return `stripe-session-${sessionId}`;
}

async function shopifyRest(path, method = 'GET', body) {
  const url = `https://${DOMAIN}/admin/api/${API_VERSION}/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { _raw: text };
  }
  if (!res.ok) {
    const msg = data.errors ? JSON.stringify(data.errors) : text;
    throw new Error(`Shopify ${method} ${path} ${res.status}: ${msg}`);
  }
  return data;
}

async function shopifyGraphQL(query, variables = {}) {
  const url = `https://${DOMAIN}/admin/api/${API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Shopify GraphQL ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

/** True if an order tagged for this Stripe session already exists. */
async function orderExistsForSession(sessionId) {
  const data = await shopifyGraphQL(
    `query ($q: String!) {
       orders(first: 1, query: $q) { edges { node { id } } }
     }`,
    { q: `tag:'${sessionTag(sessionId)}'` }
  );
  return data.orders.edges.length > 0;
}

/**
 * Create a paid Shopify order from a completed Stripe Checkout Session.
 *
 * @param {object}   p
 * @param {string}   p.sessionId       Stripe checkout session id
 * @param {Array}    p.lineItems       [{ variant_id, quantity }]
 * @param {string}   p.email
 * @param {number}   p.amountTotal     Stripe amount_total (integer cents)
 * @param {string}   p.currency        ISO code, e.g. "EUR"
 * @param {object}   p.customer        { first_name, last_name, phone }
 * @param {object?}  p.shippingAddress Shopify address shape (or null)
 * @param {object?}  p.billingAddress  Shopify address shape (or null)
 */
async function createOrder(p) {
  const amount = (p.amountTotal / 100).toFixed(2);

  const order = {
    line_items: p.lineItems,
    email: p.email,
    financial_status: 'paid',
    // Decrement stock like a real order (respects "continue selling" policy).
    inventory_behaviour: 'decrement_obeying_policy',
    currency: (p.currency || 'EUR').toUpperCase(),
    tags: `stripe-checkout, ${sessionTag(p.sessionId)}`,
    note: `Stripe Checkout (test) — session ${p.sessionId}`,
    transactions: [
      {
        kind: 'sale',
        status: 'success',
        amount,
        gateway: 'Stripe (test)',
      },
    ],
    // Test store: don't trigger customer-facing emails.
    send_receipt: false,
    send_fulfillment_receipt: false,
  };

  if (p.customer && (p.customer.first_name || p.email)) {
    order.customer = {
      email: p.email,
      first_name: p.customer.first_name || '',
      last_name: p.customer.last_name || '',
    };
  }
  if (p.shippingAddress) order.shipping_address = p.shippingAddress;
  if (p.billingAddress) order.billing_address = p.billingAddress;

  const created = await shopifyRest('orders.json', 'POST', { order });
  return created.order;
}

module.exports = { orderExistsForSession, createOrder };
