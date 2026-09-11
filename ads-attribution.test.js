const test = require('node:test');
const assert = require('node:assert/strict');
const ads = require('./ads-attribution');

test('pickGoogleClickId keeps only gclid when several ids are present', () => {
  assert.deepEqual(
    ads.pickGoogleClickId({ gclid: 'abc', gbraid: 'gb', wbraid: 'wb' }),
    { gclid: 'abc', gbraid: '', wbraid: '' }
  );
});

test('pickGoogleClickId prefers wbraid over gbraid', () => {
  assert.deepEqual(
    ads.pickGoogleClickId({ gbraid: 'gb', wbraid: 'wb' }),
    { gclid: '', gbraid: '', wbraid: 'wb' }
  );
});

test('pickGoogleClickId reads nested utms and ignores blanks', () => {
  assert.deepEqual(
    ads.pickGoogleClickId({ gclid: '  ', utms: { gclid: 'from-utm' } }),
    { gclid: 'from-utm', gbraid: '', wbraid: '' }
  );
});

test('normalizePackageSlug maps names and ids', () => {
  assert.equal(ads.normalizePackageSlug('Pro'), 'pro');
  assert.equal(ads.normalizePackageSlug({ id: 'premium', name: 'Premium' }), 'premium');
  assert.equal(ads.normalizePackageSlug('Starter'), null);
});

test('normalizeLanguage defaults to nl', () => {
  assert.equal(ads.normalizeLanguage('en'), 'en');
  assert.equal(ads.normalizeLanguage('EN-GB'), 'en');
  assert.equal(ads.normalizeLanguage(''), 'nl');
  assert.equal(ads.normalizeLanguage('de'), 'nl');
});

test('buildConversionMessage has no PII and a numeric ex-VAT value', () => {
  const msg = ads.buildConversionMessage({
    packageSlug: 'pro',
    language: 'nl',
    value: 540.006,
    orderId: 'tr_123'
  });
  assert.deepEqual(msg, {
    type: 'kiyoh_checkout_complete',
    package: 'pro',
    language: 'nl',
    value: 540.01,
    currency: 'EUR',
    orderId: 'tr_123'
  });
  assert.equal(JSON.stringify(msg).includes('@'), false);
});

test('shouldNotifyKiyohAds skips sales-portal, invoices, and other tenants', () => {
  assert.equal(ads.shouldNotifyKiyohAds({ packageSlug: 'go' }, 'kiyoh'), true);
  assert.equal(ads.shouldNotifyKiyohAds({ packageId: 'Pro' }, 'kiyoh'), true);
  assert.equal(ads.shouldNotifyKiyohAds({ packageSlug: 'go', source: 'sales-portal' }, 'kiyoh'), false);
  assert.equal(ads.shouldNotifyKiyohAds({ packageSlug: 'go', invoice_id: 'INV1' }, 'kiyoh'), false);
  assert.equal(ads.shouldNotifyKiyohAds({ packageSlug: 'go' }, 'klantenvertellen'), false);
});

test('crm payload exposes a single top-level click id and ex-VAT value', () => {
  const crm = require('./crm');
  const payload = crm.buildPayload({
    yearlyAmount: '653.40',
    yearlyAmountExVat: '540.00',
    packageId: 'Pro',
    modulesList: '',
    utms: { utm_source: 'google', gclid: 'Cj0', gbraid: 'should-drop' },
    customerName: 'Ada',
    businessName: 'Ada BV',
    customerEmail: 'ada@example.com'
  }, 'tr_abc');
  assert.equal(payload.gclid, 'Cj0');
  assert.equal(payload.gbraid, undefined);
  assert.equal(payload.wbraid, undefined);
  assert.equal(payload.utm.gclid, 'Cj0');
  assert.equal(payload.utm.gbraid, undefined);
  assert.equal(payload.deal_waarde_ex_btw, '540.00');
  assert.equal(payload.external_id, 'tr_abc');
});
