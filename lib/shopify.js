/**
 * Shopify Admin API helpers.
 *
 * - orderExistsForSession(): idempotency guard. Every order we create is
 *   tagged `stripe-session-<id>`; before creating we search by that tag so
 *   Stripe webhook retries never produce duplicate orders. No DB needed.
 * - createOrder(): REST create with inventory_behaviour decrement so stock
 *   drops exactly like a normal Shopify order.
 */

const crypto = require('crypto');

const DOMAIN = process.env.SHOPIFY_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

// Shopify rejects long order tags ("Order tags is invalid"), and real
// Stripe session ids are long, so the idempotency tag is a short stable
// hash of the session id. Used for both writing and looking up the order,
// so write/read stay consistent. The full session id still goes in `note`.
function sessionTag(sessionId) {
  const h = crypto
    .createHash('sha256')
    .update(String(sessionId))
    .digest('hex')
    .slice(0, 16);
  return `sp-${h}`;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch with exponential backoff on Shopify rate-limit (429) / 5xx /
// network errors, honouring Retry-After. Shopify's REST bucket is small
// (≈2 req/s) so transient 429s are normal under load.
async function resilientFetch(url, options) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, options);
      if (RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
        const ra = parseFloat(res.headers.get('retry-after'));
        const wait = Number.isFinite(ra)
          ? ra * 1000
          : Math.min(2 ** attempt * 400, 8000);
        await sleep(wait);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (attempt === MAX_RETRIES) throw e;
      await sleep(Math.min(2 ** attempt * 400, 8000));
    }
  }
  throw lastErr || new Error('Shopify request failed after retries');
}

async function shopifyRest(path, method = 'GET', body) {
  const url = `https://${DOMAIN}/admin/api/${API_VERSION}/${path}`;
  const res = await resilientFetch(url, {
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
  const res = await resilientFetch(url, {
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
 * Look up the order created for a Stripe session and return the native
 * Shopify order-status page URL (the standard "thank you" page, no login
 * required). Used by the post-payment confirmation page to forward the
 * shopper once the webhook has created the order.
 *
 * @returns {Promise<{ready:boolean, name?:string, statusUrl?:string}>}
 */
async function getOrderStatusForSession(sessionId) {
  const data = await shopifyGraphQL(
    `query ($q: String!) {
       orders(first: 1, query: $q) {
         edges { node { name statusPageUrl } }
       }
     }`,
    { q: `tag:'${sessionTag(sessionId)}'` }
  );
  const node = data.orders.edges[0]?.node;
  if (!node) return { ready: false };
  return { ready: true, name: node.name, statusUrl: node.statusPageUrl };
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
 * @param {Array?}   p.shippingLines   [{ title, price }] (or empty)
 * @param {Array?}   p.noteAttributes  [{ name, value }] (or empty)
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
    // Neutral, non-revealing labels in the Shopify admin. The opaque
    // sessionTag (sp-<hash>) is what idempotency/lookup use.
    tags: `web, ${sessionTag(p.sessionId)}`,
    note: 'Pedido online',
    transactions: [
      {
        kind: 'sale',
        status: 'success',
        amount,
        gateway: 'manual',
      },
    ],
    // Send the standard Shopify customer emails (order confirmation now,
    // shipping confirmation on fulfillment) — behaves like a normal order.
    send_receipt: true,
    send_fulfillment_receipt: true,
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
  if (p.shippingLines && p.shippingLines.length)
    order.shipping_lines = p.shippingLines;
  if (p.noteAttributes && p.noteAttributes.length)
    order.note_attributes = p.noteAttributes;
  if (p.discountCodes && p.discountCodes.length)
    order.discount_codes = p.discountCodes;

  const created = await shopifyRest('orders.json', 'POST', { order });
  return created.order;
}

// Spanish postal codes we do NOT ship to: 07 Baleares, 35 Las Palmas,
// 38 Santa Cruz de Tenerife, 51 Ceuta, 52 Melilla.
function isExcludedSpanishCP(cp) {
  return /^(07|35|38|51|52)/.test(String(cp || '').replace(/\D/g, ''));
}

/**
 * Re-check live Shopify inventory before payment.
 * @param {Array} items [{ id (variant id), quantity, name }]
 * @returns {Promise<{ok:boolean, problems:string[]}>}
 */
async function checkStock(items) {
  const problems = [];
  for (const it of items) {
    try {
      const { variant } = await shopifyRest(
        `variants/${it.id}.json?fields=id,title,inventory_quantity,inventory_management,inventory_policy`
      );
      if (!variant) {
        problems.push(it.name || `#${it.id}`);
        continue;
      }
      const tracked = variant.inventory_management === 'shopify';
      const allowOversell = variant.inventory_policy === 'continue';
      if (tracked && !allowOversell && variant.inventory_quantity < it.quantity) {
        problems.push(it.name || variant.title || `#${it.id}`);
      }
    } catch (e) {
      // If we can't verify, don't block the sale on a transient API error.
      console.error('[checkStock]', it.id, e.message);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Validate a Shopify discount code for an ORDER-LEVEL discount only.
 * Supports DiscountCodeBasic, status ACTIVE, applies to ALL items
 * (AllDiscountItems), percentage or fixed amount, optional minimum
 * subtotal/quantity. Collection/product-scoped, BOGO, free-shipping,
 * inactive/expired → { ok:false, reason }.
 *
 * @param {string} code
 * @param {number} subtotalCents product subtotal in cents
 * @param {number} totalQty      total item quantity
 */
async function validateDiscount(code, subtotalCents, totalQty) {
  const clean = String(code || '').trim();
  if (!clean) return { ok: false, reason: 'Introduce un código de descuento.' };

  const data = await shopifyGraphQL(
    `query ($code: String!) {
       codeDiscountNodeByCode(code: $code) {
         codeDiscount {
           __typename
           ... on DiscountCodeBasic {
             status
             customerGets {
               items { __typename }
               value {
                 __typename
                 ... on DiscountPercentage { percentage }
                 ... on DiscountAmount { amount { amount } }
               }
             }
             minimumRequirement {
               __typename
               ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
               ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
             }
           }
         }
       }
     }`,
    { code: clean }
  );

  const cd =
    data.codeDiscountNodeByCode && data.codeDiscountNodeByCode.codeDiscount;
  if (!cd) return { ok: false, reason: 'Código de descuento no válido.' };
  if (cd.__typename !== 'DiscountCodeBasic')
    return { ok: false, reason: 'Este cupón no es compatible con este checkout.' };
  if (cd.status !== 'ACTIVE')
    return { ok: false, reason: 'Este cupón no está activo o ha caducado.' };

  const items = cd.customerGets && cd.customerGets.items;
  if (!items || items.__typename !== 'AllDiscountItems')
    return {
      ok: false,
      reason:
        'Este cupón solo aplica a productos o colecciones concretos; no es compatible aquí.',
    };

  const min = cd.minimumRequirement;
  if (min && min.__typename === 'DiscountMinimumSubtotal') {
    const minCents = Math.round(
      parseFloat(min.greaterThanOrEqualToSubtotal.amount) * 100
    );
    if (subtotalCents < minCents)
      return {
        ok: false,
        reason: `Este cupón requiere un mínimo de ${(minCents / 100).toFixed(2)} €.`,
      };
  } else if (min && min.__typename === 'DiscountMinimumQuantity') {
    if (totalQty < parseInt(min.greaterThanOrEqualToQuantity, 10))
      return {
        ok: false,
        reason: `Este cupón requiere un mínimo de ${min.greaterThanOrEqualToQuantity} artículos.`,
      };
  }

  const val = cd.customerGets.value;
  if (val.__typename === 'DiscountPercentage') {
    const pct = Number(val.percentage); // 0.1 = 10%
    if (!(pct > 0)) return { ok: false, reason: 'Cupón sin valor de descuento.' };
    return {
      ok: true,
      code: clean,
      type: 'percentage',
      percent: Math.round(pct * 100),
      amountCents: Math.round(subtotalCents * pct),
    };
  }
  if (val.__typename === 'DiscountAmount') {
    const amt = Math.round(parseFloat(val.amount.amount) * 100);
    if (!(amt > 0)) return { ok: false, reason: 'Cupón sin valor de descuento.' };
    return {
      ok: true,
      code: clean,
      type: 'fixed',
      amountCents: Math.min(amt, subtotalCents),
    };
  }
  return { ok: false, reason: 'Tipo de cupón no soportado.' };
}

module.exports = {
  orderExistsForSession,
  getOrderStatusForSession,
  createOrder,
  isExcludedSpanishCP,
  checkStock,
  validateDiscount,
};
