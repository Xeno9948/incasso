/**
 * Google Ads / GA4 / Meta attribution for the kiyoh.com checkout iframe.
 *
 * Path 1 (real-time): success.html postMessages kiyoh_checkout_complete to
 * the parent. GTM on kiyoh.com fires GA4 purchase, Google Ads Pakket
 * conversions and a consent-gated Meta Purchase. This origin never loads
 * gtag, GTM or a Meta pixel. The parent accepts the message only when
 * event.origin === https://payment.kiyoh.com, and dedupes on orderId.
 *
 * Value decision (do not send incl. VAT):
 *   value is the yearly subscription total EXCLUDING VAT (net): monthly
 *   package + modules, times 12, before VAT. Mollie charges yearlyAmount
 *   which is that net total plus VAT (default 21%). GA4 and Google Ads
 *   both receive this same net number so they match each other and the
 *   CRM field deal_waarde_ex_btw. currency is always 'EUR'. orderId is
 *   the Mollie payment id (tr_...), not a cart id.
 *
 * Path 1 payload:
 *   { type: 'kiyoh_checkout_complete',
 *     package: 'go'|'pro'|'premium', language: 'nl'|'en',
 *     value: <number, ex-VAT yearly>, currency: 'EUR',
 *     orderId: 'tr_...', email?: '<buyer email>' }
 * email is included so the parent can run enhanced conversions. No other
 * PII (name, phone, address) is included. targetOrigin is a kiyoh.com
 * parent origin, never '*'.
 *
 * Path 2 (durable): persist gclid, gbraid, wbraid AND fbclid on the Mollie
 * payment metadata and on the redirect/return URL so they survive Mollie's
 * redirect and can be used for a later offline conversion upload.
 * The CRM webhook still sends exactly one Google click id (gclid, else
 * wbraid, else gbraid) because Google offline import accepts one. Dedupes
 * with Path 1 via external_id === orderId.
 *
 * Aanmelding NL is owned by the CRM offline import — do not postMessage it.
 */

const KIYOH_PARENT_ORIGINS = Object.freeze([
  'https://kiyoh.com',
  'https://www.kiyoh.com',
  'https://kiyoh-com-production.up.railway.app'
]);
const PACKAGE_SLUGS = Object.freeze(['go', 'pro', 'premium']);
// Google Ads offline import accepts at most one click id. gclid is standard
// web; wbraid is iOS web; gbraid is iOS app. Used only for the CRM payload.
const CLICK_ID_PRIORITY = Object.freeze(['gclid', 'wbraid', 'gbraid']);
// All of these are stored on the order. Unlike CLICK_ID_PRIORITY, none is dropped.
const CLICK_IDS_TO_PERSIST = Object.freeze(['gclid', 'gbraid', 'wbraid', 'fbclid']);
const UTM_KEYS_FOR_MOLLIE = Object.freeze([
  'utm_source', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'li_fat_id', 'ga4id', 'user_agent', 'user_ip'
]);
// Mollie metadata is capped at about 1kB. Stay under that without touching
// amounts or customer fields.
const MOLLIE_METADATA_MAX_BYTES = 1000;
// Mollie rejects an over-long redirectUrl. Click ids that do not fit stay
// on the payment metadata; the return URL keeps as many as it can.
const SUCCESS_REDIRECT_MAX_LENGTH = 1024;
const RETRYABLE_UNPAID_STATUSES = Object.freeze(['open', 'pending', 'authorized']);
const CHECKOUT_CHANNEL = 'kiyoh_checkout_complete';

function asTrimmedString(value) {
  if (value == null) return '';
  return String(value).trim();
}

function normalizeLanguage(value) {
  const v = asTrimmedString(value).toLowerCase().slice(0, 2);
  return v === 'en' ? 'en' : 'nl';
}

function normalizePackageSlug(pkg) {
  if (pkg == null) return null;
  const raw = asTrimmedString(typeof pkg === 'object' ? (pkg.id || pkg.name || '') : pkg).toLowerCase();
  if (!raw) return null;
  if (PACKAGE_SLUGS.includes(raw)) return raw;
  for (const slug of PACKAGE_SLUGS) {
    if (raw.includes(slug)) return slug;
  }
  return null;
}

function conversionValueExVat(yearlyTotalExcl) {
  const n = typeof yearlyTotalExcl === 'number' ? yearlyTotalExcl : parseFloat(yearlyTotalExcl);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * Buyer email for enhanced conversions. Trimmed and lowercased.
 * Empty when the value is not a single email address.
 */
function normalizeEmail(value) {
  const v = asTrimmedString(value).toLowerCase();
  if (!v || v.length > 254) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return '';
  return v;
}

/**
 * Return at most one Google click id, in priority order.
 * Empty strings for the other two so CRM field mappings stay stable.
 */
function pickGoogleClickId(source) {
  const out = { gclid: '', gbraid: '', wbraid: '' };
  if (!source || typeof source !== 'object') return out;

  const merged = { ...source };
  if (source.utms && typeof source.utms === 'object') {
    for (const key of CLICK_ID_PRIORITY) {
      if (!asTrimmedString(merged[key])) merged[key] = source.utms[key];
    }
  }

  for (const key of CLICK_ID_PRIORITY) {
    const val = asTrimmedString(merged[key]);
    if (val) {
      out[key] = val.slice(0, 200);
      return out;
    }
  }
  return out;
}

/**
 * Every click id present on the iframe query / checkout body.
 * Does not drop siblings: gclid and fbclid can both be stored.
 */
function collectClickIds(source) {
  const out = { gclid: '', gbraid: '', wbraid: '', fbclid: '' };
  if (!source || typeof source !== 'object') return out;

  const merged = { ...source };
  if (source.utms && typeof source.utms === 'object') {
    for (const key of CLICK_IDS_TO_PERSIST) {
      if (!asTrimmedString(merged[key])) merged[key] = source.utms[key];
    }
  }

  for (const key of CLICK_IDS_TO_PERSIST) {
    out[key] = asTrimmedString(merged[key]).slice(0, 200);
  }
  return out;
}

function attributionMetadata(clickIds) {
  const ids = collectClickIds(clickIds);
  const out = {};
  for (const key of CLICK_IDS_TO_PERSIST) {
    if (ids[key]) out[key] = ids[key];
  }
  return out;
}

function compactUtmsForMollie(utms, clickIds) {
  const src = utms && typeof utms === 'object' ? utms : {};
  const out = {};
  for (const key of UTM_KEYS_FOR_MOLLIE) {
    if (CLICK_IDS_TO_PERSIST.includes(key)) continue;
    const val = asTrimmedString(src[key]);
    if (val) out[key] = key === 'user_agent' ? val.slice(0, 70) : val.slice(0, 200);
  }
  const ids = collectClickIds(src);
  const overlay = collectClickIds(clickIds);
  for (const key of CLICK_IDS_TO_PERSIST) {
    const val = overlay[key] || ids[key];
    if (val) out[key] = val.slice(0, 200);
  }
  return out;
}

function metadataByteLength(metadata) {
  return Buffer.byteLength(JSON.stringify(metadata), 'utf8');
}

/**
 * Keep Mollie metadata under the ~1kB cap. Drops only bulky attribution
 * extras (user agent, IP, duplicate click ids). Never drops amounts,
 * package, or customer fields.
 */
function fitMollieMetadata(metadata, maxBytes = MOLLIE_METADATA_MAX_BYTES) {
  const meta = JSON.parse(JSON.stringify(metadata || {}));
  const size = () => metadataByteLength(meta);
  if (size() <= maxBytes) return meta;

  const dropUtm = ['user_agent', 'user_ip', 'li_fat_id', 'ga4id'];
  for (const key of dropUtm) {
    if (meta.utms && typeof meta.utms === 'object') delete meta.utms[key];
    if (size() <= maxBytes) return meta;
  }

  if (meta.utms && typeof meta.utms === 'object') {
    for (const key of CLICK_IDS_TO_PERSIST) {
      if (meta[key] && meta.utms[key]) delete meta.utms[key];
    }
    if (size() <= maxBytes) return meta;
  }

  for (const cap of [120, 80, 50]) {
    for (const key of CLICK_IDS_TO_PERSIST) {
      if (typeof meta[key] === 'string' && meta[key].length > cap) meta[key] = meta[key].slice(0, cap);
      if (meta.utms && typeof meta.utms[key] === 'string' && meta.utms[key].length > cap) {
        meta.utms[key] = meta.utms[key].slice(0, cap);
      }
    }
    if (size() <= maxBytes) return meta;
  }
  return meta;
}

/**
 * Mollie redirect/return URL. orderId is the payment id. Click ids are
 * appended so they are still on the URL after Mollie redirects, and are
 * dropped from the end (fbclid first) if the URL would exceed Mollie's limit.
 */
function buildSuccessRedirectUrl(baseUrl, { orderId, tenant, clickIds } = {}) {
  const ids = collectClickIds(clickIds);
  const ordered = CLICK_IDS_TO_PERSIST.filter(key => ids[key]);

  function make(active) {
    const u = new URL('/success.html', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
    u.searchParams.set('orderId', asTrimmedString(orderId));
    u.searchParams.set('tenant', asTrimmedString(tenant) || 'kiyoh');
    for (const key of active) u.searchParams.set(key, ids[key]);
    return u.toString();
  }

  let active = ordered.slice();
  let url = make(active);
  while (url.length > SUCCESS_REDIRECT_MAX_LENGTH && active.length) {
    active.pop();
    url = make(active);
  }
  return url;
}

/**
 * Payload the iframe posts to kiyoh.com.
 * GTM uses orderId as transaction_id to dedupe Path 1 vs Path 2.
 * value is the ex-VAT yearly total (see file header).
 */
function buildConversionMessage({ packageSlug, language, value, orderId, email }) {
  const message = {
    type: 'kiyoh_checkout_complete',
    package: packageSlug,
    language: normalizeLanguage(language),
    value: conversionValueExVat(value),
    currency: 'EUR',
    orderId: asTrimmedString(orderId)
  };
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) message.email = normalizedEmail;
  return message;
}

function shouldNotifyKiyohAds(metadata, tenant) {
  if ((tenant || (metadata && metadata.tenant) || 'kiyoh') !== 'kiyoh') return false;
  if (!metadata) return false;
  if (metadata.source === 'sales-portal') return false;
  if (metadata.invoice_id) return false;
  return !!normalizePackageSlug(metadata.packageSlug || metadata.packageId);
}

/**
 * open/pending/authorized can still flip to paid in the seconds after
 * Mollie redirects. failed/canceled/expired must not be retried into a post.
 */
function shouldRetryUnpaidStatus(status) {
  return RETRYABLE_UNPAID_STATUSES.includes(status);
}

/**
 * Body for GET /api/checkout-complete. notify is true only when Mollie
 * status is exactly 'paid' and this is a kiyoh storefront checkout.
 */
function buildCheckoutCompleteResponse(payment, tenant) {
  const orderId = payment && payment.id ? String(payment.id) : '';
  const status = payment && payment.status ? String(payment.status) : '';
  if (status !== 'paid') {
    return {
      httpStatus: 409,
      body: { notify: false, error: 'Payment not paid', status }
    };
  }

  const metadata = payment.metadata || {};
  if (!shouldNotifyKiyohAds(metadata, metadata.tenant || tenant)) {
    return { httpStatus: 200, body: { notify: false, orderId } };
  }

  const packageSlug = normalizePackageSlug(metadata.packageSlug || metadata.packageId);
  const message = buildConversionMessage({
    packageSlug,
    language: metadata.language,
    value: metadata.yearlyAmountExVat,
    orderId: payment.id,
    email: metadata.customerEmail
  });

  if (!message.package || !message.value) {
    return { httpStatus: 200, body: { notify: false, orderId } };
  }

  return { httpStatus: 200, body: { notify: true, ...message } };
}

module.exports = {
  KIYOH_PARENT_ORIGINS,
  PACKAGE_SLUGS,
  CLICK_ID_PRIORITY,
  CLICK_IDS_TO_PERSIST,
  CHECKOUT_CHANNEL,
  RETRYABLE_UNPAID_STATUSES,
  MOLLIE_METADATA_MAX_BYTES,
  normalizeLanguage,
  normalizePackageSlug,
  normalizeEmail,
  conversionValueExVat,
  pickGoogleClickId,
  collectClickIds,
  attributionMetadata,
  compactUtmsForMollie,
  fitMollieMetadata,
  buildSuccessRedirectUrl,
  buildConversionMessage,
  shouldNotifyKiyohAds,
  shouldRetryUnpaidStatus,
  buildCheckoutCompleteResponse
};
