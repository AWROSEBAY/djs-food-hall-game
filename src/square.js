// Square webhooks and API lookups.
// Docs: https://developer.squareup.com/docs/webhooks/step3validate

import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalisePhone } from './engine.js';
import { LOCATIONS } from './config.js';

const API = process.env.SQUARE_ENV === 'sandbox'
  ? 'https://connect.squareupsandbox.com'
  : 'https://connect.squareup.com';
const VERSION = process.env.SQUARE_VERSION || '2025-01-23';

// Square signs notificationUrl + raw body with the subscription's signature key.
export function verifySignature({ signature, body, url, key }) {
  if (!signature || !key) return false;
  const expected = createHmac('sha256', key).update(url + body).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function get(path, token) {
  const res = await fetch(API + path, {
    headers: { Authorization: `Bearer ${token}`, 'Square-Version': VERSION, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Square ${path} -> ${res.status}`);
  return res.json();
}

// Work out whose phone a payment belongs to: the attached Square customer first
// (set by Square Loyalty at the counter, or by the online checkout), then the
// pickup recipient on the order (kiosk and online orders).
export async function phoneForPayment(payment, token, fetcher = get) {
  if (payment.customer_id) {
    const { customer } = await fetcher(`/v2/customers/${payment.customer_id}`, token);
    const p = normalisePhone(customer?.phone_number);
    if (p) return p;
  }
  if (payment.order_id) {
    const { order } = await fetcher(`/v2/orders/${payment.order_id}`, token);
    for (const f of order?.fulfillments || []) {
      const details = f.pickup_details || f.delivery_details || f.shipment_details;
      const p = normalisePhone(details?.recipient?.phone_number);
      if (p) return p;
    }
  }
  return null;
}

// Turn a webhook event into something the game understands, or null to ignore it.
export async function parseEvent(event, token, fetcher = get) {
  const type = event?.type;
  const obj = event?.data?.object || {};

  if (type === 'payment.created' || type === 'payment.updated') {
    const p = obj.payment;
    if (!p || p.status !== 'COMPLETED') return null;
    if (!LOCATIONS[p.location_id]) return null; // not a DJES outlet
    const phone = await phoneForPayment(p, token, fetcher);
    if (!phone) return { kind: 'unmatched_payment', paymentId: p.id };
    return {
      kind: 'payment',
      paymentId: p.id,
      phone,
      locationId: p.location_id,
      amountCents: p.amount_money?.amount ?? 0, // excludes tips
      paidAt: p.updated_at || p.created_at,
    };
  }

  if (type === 'refund.created' || type === 'refund.updated') {
    const r = obj.refund;
    if (!r || r.status !== 'COMPLETED') return null;
    const { payment } = await fetcher(`/v2/payments/${r.payment_id}`, token);
    return {
      kind: 'refund',
      paymentId: r.payment_id,
      refundedCents: payment?.refunded_money?.amount ?? r.amount_money?.amount ?? 0,
    };
  }

  return null;
}
