/**
 * CRM webhook sender for "Won" leads. Posts the same payload shape
 * the inline webhook code used to send, but in a reusable helper so
 * the paid-payment flow AND the admin "resend" button can both call it.
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { pickGoogleClickId } = require('./ads-attribution');

function buildPayload(metadata, paymentId, opts = {}) {
  const {
    yearlyAmount, yearlyAmountExVat, packageId, modulesList, utms,
    customerName, businessName, website, customerEmail, customerPhone,
    businessAddress, businessPostal, businessCity, businessCountry, kvkNumber
  } = metadata;

  const explicitMessage = `Pakket geselecteerd: ${packageId}
Modules geselecteerd: ${modulesList || 'Geen extra modules'}
Adres: ${businessAddress || ''}
Postcode: ${businessPostal || ''}
Plaats: ${businessCity || ''}
Land: ${businessCountry || ''}
KVK: ${kvkNumber || ''}`;

  const click = pickGoogleClickId(metadata);
  const utm = { ...(utms || {}) };
  // Keep CRM mappings stable: exactly one of gclid / wbraid / gbraid.
  delete utm.gclid;
  delete utm.gbraid;
  delete utm.wbraid;
  if (click.gclid) utm.gclid = click.gclid;
  else if (click.wbraid) utm.wbraid = click.wbraid;
  else if (click.gbraid) utm.gbraid = click.gbraid;

  const payload = {
    aanmelding_type: 'Kiyoh Online Abonnement',
    bedrijf: businessName || customerName,
    contactpersoon: customerName,
    website: website || '',
    telefoon: customerPhone || '',
    email: customerEmail,
    collega: 'Systeem',
    status: opts.status || 'Won',
    upsell: 'NB',
    product: 'Kiyoh',
    message: explicitMessage,
    feature: packageId,
    deal_waarde: yearlyAmount,
    deal_waarde_ex_btw: yearlyAmountExVat || '',
    kvk: kvkNumber || '',
    adres: businessAddress || '',
    postcode: businessPostal || '',
    plaats: businessCity || '',
    land: businessCountry || '',
    source: utms ? (utms.utm_source || utms.source || 'website') : 'website',
    external_id: paymentId,
    utm
  };

  // Top-level click ids so the CRM offline conversion import does not
  // have to dig through utm. Only the matching key is populated.
  if (click.gclid) payload.gclid = click.gclid;
  if (click.wbraid) payload.wbraid = click.wbraid;
  if (click.gbraid) payload.gbraid = click.gbraid;

  return payload;
}

/**
 * Send the "Won" CRM webhook. Throws on network error or non-2xx
 * response so the caller can log status accordingly.
 */
async function sendWonLead(crmUrl, metadata, paymentId, opts = {}) {
  if (!crmUrl) throw new Error('crmWebhookUrl not configured');

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Kiyoh-Webhook-Client/1.0'
  };
  if (opts.webhookSecret) headers['X-Webhook-Secret'] = opts.webhookSecret;

  const resp = await fetch(crmUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(buildPayload(metadata, paymentId, { status: 'Won' }))
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`CRM ${resp.status}: ${txt.slice(0, 300)}`);
  }
  return { status: resp.status };
}

module.exports = { sendWonLead, buildPayload };
