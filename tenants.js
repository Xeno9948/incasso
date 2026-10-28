// Tenant registry + per-tenant settings helpers (pure functions, unit-tested).
const crypto = require('crypto');

const TENANTS = [
  { id: 'kiyoh', name: 'Kiyoh', currency: 'EUR', locale: 'nl-NL', brandColor: '#f58220', badge: 'NL' },
  { id: 'klantenvertellen', name: 'Klantenvertellen', currency: 'EUR', locale: 'nl-NL', brandColor: '#0066cc', badge: 'NL' },
  { id: 'kiyoh-cz', name: 'Kiyoh CZ', currency: 'CZK', locale: 'cs-CZ', brandColor: '#d7141a', badge: 'CZ' }
];
const TENANT_IDS = TENANTS.map(t => t.id);
const isKnownTenant = t => TENANT_IDS.includes(t);

// Events that can notify people / webhooks.
const EVENTS = ['order', 'signup', 'dealPaid', 'cancellation'];
const LEGACY_DEFAULT_TO = 'info@klantenvertellen.nl';
const LEGACY_DEFAULT_CC = ['xeno@kiyoh.com'];

const splitList = v => (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/))
  .map(s => String(s).trim()).filter(Boolean);

/**
 * Effective notification settings. When a tenant has no `notifications`
 * block yet, defaults reproduce the pre-existing behaviour exactly:
 * internal mails go to smtpTo (fallback info@klantenvertellen.nl), and
 * xeno@kiyoh.com is BCC'd on every mail. Cancellation mails are new and
 * off by default. Per-event webhooks are new and empty by default (the
 * existing CRM webhook, crmWebhookUrl, is unaffected).
 */
function getNotifications(cfg) {
  const n = (cfg && cfg.notifications) || {};
  const baseTo = cfg && cfg.smtpTo ? splitList(cfg.smtpTo) : [LEGACY_DEFAULT_TO];
  const cc = n.cc !== undefined ? splitList(n.cc) : LEGACY_DEFAULT_CC.slice();
  const events = {};
  for (const ev of EVENTS) {
    const e = (n.events && n.events[ev]) || {};
    events[ev] = {
      enabled: e.enabled !== undefined ? !!e.enabled : ev !== 'cancellation',
      // signup: the welcome mail already goes to the customer; extra internal
      // recipients are opt-in (default none) so nothing new is sent.
      recipients: e.recipients !== undefined ? splitList(e.recipients) : (ev === 'signup' ? [] : baseTo.slice()),
      webhookUrl: e.webhookUrl || '',
      webhookSecret: e.webhookSecret || ''
    };
  }
  const accountant = n.accountant !== undefined ? splitList(n.accountant).join(', ') : 'administratie@kv-review.nl';
  return { cc, events, accountant };
}

/** Recipients for an internal mail of `event`: { to, bcc, enabled }. */
function resolveRecipients(cfg, event) {
  const n = getNotifications(cfg);
  const e = n.events[event] || n.events.order;
  return { enabled: e.enabled, to: e.recipients.join(', '), bcc: n.cc.join(', '), accountant: n.accountant };
}

function signWebhook(body, secret) {
  return secret ? crypto.createHmac('sha256', secret).update(body).digest('hex') : '';
}

/**
 * Mollie key resolution. Order is unchanged from before, with one optional
 * step in front: an env var NAME the admin chose for this tenant
 * (payment.liveKeyEnv / payment.testKeyEnv). Returns the key plus where it came from.
 */
function resolveMollieKey(cfg, tenant, env, testMode) {
  const p = (cfg && cfg.payment) || {};
  const suffix = '_' + String(tenant).toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const kind = testMode ? 'TEST' : 'LIVE';
  const apiKeyEnv = env.MOLLIE_API_KEY || '';
  const prefix = testMode ? 'test_' : 'live_';
  const custom = testMode ? p.testKeyEnv : p.liveKeyEnv;
  const chain = [
    custom ? ['env:' + custom, env[custom]] : null,
    ['env:MOLLIE_' + kind + '_KEY' + suffix, env['MOLLIE_' + kind + '_KEY' + suffix]],
    ['env:MOLLIE_' + kind + '_KEY', env['MOLLIE_' + kind + '_KEY']],
    ['env:MOLLIE_API_KEY', apiKeyEnv.startsWith(prefix) ? apiKeyEnv : ''],
    ['admin-config', testMode ? cfg.mollieTestKey : cfg.mollieLiveKey]
  ].filter(Boolean);
  for (const [source, key] of chain) if (key) return { key, source };
  return { key: '', source: null };
}

function paymentStatus(cfg, tenant, env) {
  const testMode = cfg.mollieTestMode !== false;
  const live = resolveMollieKey(cfg, tenant, env, false);
  const test = resolveMollieKey(cfg, tenant, env, true);
  return {
    provider: (cfg.payment && cfg.payment.provider) || 'mollie',
    mode: testMode ? 'test' : 'live',
    methods: cfg.mollieMethods || '',
    liveKeyEnv: (cfg.payment && cfg.payment.liveKeyEnv) || '',
    testKeyEnv: (cfg.payment && cfg.payment.testKeyEnv) || '',
    liveKeyPresent: !!live.key, liveKeySource: live.source,
    testKeyPresent: !!test.key, testKeySource: test.source,
    activeKeyPresent: !!(testMode ? test.key : live.key)
  };
}

// Sections that can be copied from one tenant to another.
const COPY_SECTIONS = {
  packages: ['packages'], modules: ['modules'], coreFeatures: ['coreFeatures'],
  pricing: ['vatPercentage', 'currency'],
  payment: ['mollieMethods', 'mollieInterval', 'molliePaymentType', 'mollieDescription', 'payment'],
  notifications: ['notifications', 'smtpTo'],
  email: ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'smtpFrom'],
  crm: ['crmWebhookUrl', 'crmWebhookSecret'],
  googleAds: ['googleAdsConversionId', 'googleAdsConversionLabel']
};
function copySections(target, source, sections) {
  const out = JSON.parse(JSON.stringify(target || {}));
  for (const s of sections) {
    for (const k of COPY_SECTIONS[s] || []) {
      if (source[k] === undefined) delete out[k];
      else out[k] = JSON.parse(JSON.stringify(source[k]));
    }
  }
  return out;
}

// Keys that are global to the admin login (not per tenant).
const GLOBAL_KEYS = ['twoFactorEnabled', 'twoFactorSecret'];

module.exports = {
  TENANTS, TENANT_IDS, isKnownTenant, EVENTS, getNotifications, resolveRecipients,
  signWebhook, resolveMollieKey, paymentStatus, COPY_SECTIONS, copySections, GLOBAL_KEYS, splitList
};
