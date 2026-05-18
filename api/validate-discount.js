/**
 * POST /api/validate-discount   { code, subtotalCents, totalQty }
 *
 * Lets the cart "Aplicar" button preview/validate a discount code before
 * going to pay. Authoritative re-validation still happens in
 * create-checkout-session; this is just for UX feedback.
 *
 *   { ok: true,  label: "PRUEBA10: -10% (ahorras 6.60 EUR)" }
 *   { ok: false, error: "Codigo de descuento no valido." }
 */

const { validateDiscount } = require('../lib/shopify');

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
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const body = await readJsonBody(req);
    const subtotalCents = Number(body.subtotalCents) || 0;
    const totalQty = Number(body.totalQty) || 1;

    const d = await validateDiscount(body.code, subtotalCents, totalQty);
    if (!d.ok) return res.status(200).json({ ok: false, error: d.reason });

    const saved = (d.amountCents / 100).toFixed(2);
    const label =
      d.type === 'percentage'
        ? `${d.code}: -${d.percent}% (ahorras ${saved} EUR)`
        : `${d.code}: -${saved} EUR`;
    return res.status(200).json({ ok: true, label });
  } catch (err) {
    console.error('[validate-discount]', err);
    return res
      .status(200)
      .json({ ok: false, error: 'No se pudo validar el codigo.' });
  }
};
