// Per-tenant admin layer: tenant switcher + badge, save warning, payment status,
// notifications editor, version history/rollback, copy-from-tenant, tenant logs.
(function () {
  var qs = new URLSearchParams(location.search);
  var TENANT = (qs.get('tenant') || 'kiyoh').toLowerCase();
  var TENANTS = [];
  var dirty = false;
  var EVENTS = { order: 'Nieuwe bestelling', signup: 'Aanmelding (welkomstmail)', dealPaid: 'Deal betaald', cancellation: 'Opzegging' };
  var SECTIONS = { packages: 'Pakketten', modules: 'Modules', coreFeatures: 'Core features', pricing: 'Valuta + BTW', payment: 'Betaalinstellingen', notifications: 'Notificaties', email: 'SMTP', crm: 'CRM-webhook', googleAds: 'Google Ads' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }

  // Admin API calls go to the selected tenant unless the URL already names one.
  function api(url) {
    if (!/[?&]tenant=/.test(url)) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'tenant=' + encodeURIComponent(TENANT);
    return url;
  }
  function info(id) { return TENANTS.filter(function (t) { return t.id === id; })[0] || { id: id, name: id, brandColor: '#888', currency: 'EUR' }; }
