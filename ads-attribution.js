/**
 * Google Ads attribution for the kiyoh.com checkout iframe.
 *
 * Path 1 (real-time): success page postMessages kiyoh_checkout_complete to
 * the parent so GTM on kiyoh.com fires the conversion with the parent's
 * gclid cookie intact. Never fire gtag from this origin. Ads firing lives
 * on the parent (GTM-N65FP7V). Parent ignores the message unless
 * event.origin === https://payment.kiyoh.com.
 *
 * Frozen Path 1 payload — do not change type, package slugs, language
 * values, or orderId without telling KIO first:
 *   { type, package: 'go'|'pro'|'premium', language: 'nl'|'en',
 *     value: <ex-VAT yearly number>, currency: 'EUR', orderId: 'tr_...' }
 *
 * Path 2 (durable): persist exactly one of gclid / wbraid / gbraid on the
 * Mollie payment and CRM webhook so the CRM can upload an offline conversion.
 * Dedupes with Path 1 via external_id === orderId.
 *
 * Aanmelding NL is owned by the CRM offline import — do not postMessage it.
 */

const KIYOH_PARENT_ORIGINS = Object.freeze(['https://kiyoh.com', 'https://www.kiyoh.com']);
const PACKAGE_SLUGS = Object.freeze(['go', 'pro', 'premium']);
// Google accepts at most one click id. gclid is standard web; wbraid is iOS
// web; gbraid is iOS app. Prefer the most attributive id that is present.
const CLICK_ID_PRIORITY = Object.freeze(['gclid', 'wbraid', 'gbraid']);
const UTM_KEYS_FOR_MOLLIE = Object.freeze([
  'utm_source', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'li_fat_id', 'ga4id', 'user_agent', 'user_ip'
]);

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
      out[key] = val;
      return out;
    }
  }
  return out;
}

function compactUtmsForMollie(utms, clickId) {
  const src = utms && typeof utms === 'object' ? utms : {};
  const out = {};
  for (const key of UTM_KEYS_FOR_MOLLIE) {
    const val = asTrimmedString(src[key]);
    if (val) out[key] = key === 'user_agent' ? val.slice(0, 70) : val.slice(0, 200);
  }
  // Overlay the single chosen click id; drop the other two so Mollie
  // metadata never carries more than one.
  delete out.gclid;
  delete out.gbraid;
  delete out.wbraid;
  if (clickId && clickId.gclid) out.gclid = clickId.gclid.slice(0, 200);
  else if (clickId && clickId.wbraid) out.wbraid = clickId.wbraid.slice(0, 200);
  else if (clickId && clickId.gbraid) out.gbraid = clickId.gbraid.slice(0, 200);
  return out;
}

/**
 * Payload the iframe posts to kiyoh.com. No PII.
 * GTM should use orderId as transaction_id to dedupe Path 1 vs Path 2.
 */
function buildConversionMessage({ packageSlug, language, value, orderId }) {
  return {
    type: 'kiyoh_checkout_complete',
    package: packageSlug,
    language: normalizeLanguage(language),
    value: conversionValueExVat(value),
    currency: 'EUR',
    orderId: asTrimmedString(orderId)
  };
}

function shouldNotifyKiyohAds(metadata, tenant) {
  if ((tenant || (metadata && metadata.tenant) || 'kiyoh') !== 'kiyoh') return false;
  if (!metadata) return false;
  if (metadata.source === 'sales-portal') return false;
  if (metadata.invoice_id) return false;
  return !!normalizePackageSlug(metadata.packageSlug || metadata.packageId);
}

module.exports = {
  KIYOH_PARENT_ORIGINS,
  PACKAGE_SLUGS,
  CLICK_ID_PRIORITY,
  normalizeLanguage,
  normalizePackageSlug,
  conversionValueExVat,
  pickGoogleClickId,
  compactUtmsForMollie,
  buildConversionMessage,
  shouldNotifyKiyohAds
};
