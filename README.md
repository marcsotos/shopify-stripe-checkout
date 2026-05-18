# shopify-stripe-checkout

A minimal serverless bridge that lets a Shopify store take payment through
**Stripe Checkout** instead of the native Shopify checkout, then recreates
the paid order back in Shopify (with stock decrement) via the Admin API.

```
Storefront "Checkout" button
   → POST /api/create-checkout-session   (cart → Stripe Checkout Session)
   → redirect to Stripe-hosted payment page
   → Stripe → POST /api/stripe-webhook   (paid → Shopify order, idempotent)
```

The webhook is the single source of truth: the order is created
server-to-server, so it lands in Shopify even if the buyer closes the tab.
Orders are tagged with the Stripe session id, so webhook retries never
create duplicates.

## Endpoints

| Route | Purpose |
|---|---|
| `POST /api/create-checkout-session` | Builds a Stripe Checkout Session from the cart and returns `{ url }`. |
| `POST /api/stripe-webhook` | Verifies the Stripe signature and creates a paid Shopify order. |

## Setup

1. Deploy to Vercel.
2. Set the environment variables — see [`.env.example`](.env.example).
3. In Stripe → Developers → Webhooks, add an endpoint for
   `checkout.session.completed` pointing at `/api/stripe-webhook`
   (snapshot payload) and put its signing secret in `STRIPE_WEBHOOK_SECRET`.
4. On the storefront, make the checkout button POST the cart JSON to
   `/api/create-checkout-session` and redirect to the returned URL.

## Notes

- Configuration is entirely via environment variables; no secrets in the repo.
- Amounts are passed in minor units (cents), matching Shopify and Stripe.
- Shipping/tax/discounts are not recalculated — the charge equals the cart total.

## License

ISC.
