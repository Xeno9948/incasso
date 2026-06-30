/**
 * CRM webhook sender for "Won" leads. Posts the same payload shape
 * the inline webhook code used to send, but in a reusable helper so
 * the paid-payment flow AND the admin "resend" button can both call it.
 */

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

function buildPayload(metadata, paymentId) {
  const {
    yearlyAmount, packageId, modulesList, utms,
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

  return {
    aanmelding_type: 'Kiyoh Online Abonnement',
    bedrijf: businessName || customerName,
    contactpersoon: customerName,
    website: website || '',
    telefoon: customerPhone || '',
    email: customerEmail,
    collega: 'Systeem',
    status: 'Won',
    upsell: 'NB',
    product: 'Kiyoh',
    message: explicitMessage,
    feature: packageId,
    deal_waarde: yearlyAmount,
    kvk: kvkNumber || '',
    adres: businessAddress || '',
    postcode: businessPostal || '',
    plaats: businessCity || '',
    land: businessCountry || '',
    source: utms ? (utms.utm_source || utms.source || 'website') : 'website',
    external_id: paymentId,
    utm: utms || {}
  };
}

/**
 * Send the "Won" CRM webhook. Throws on network error or non-2xx
 * response so the caller can log status accordingly.
 */
async function sendWonLead(crmUrl, metadata, paymentId) {
  if (!crmUrl) throw new Error('crmWebhookUrl not configured');

  const resp = await fetch(crmUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Kiyoh-Webhook-Client/1.0'
    },
    body: JSON.stringify(buildPayload(metadata, paymentId))
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`CRM ${resp.status}: ${txt.slice(0, 300)}`);
  }
  return { status: resp.status };
}

module.exports = { sendWonLead, buildPayload };
