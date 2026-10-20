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

test('buildConversionMessage sends a numeric ex-VAT value and normalized email', () => {
  const msg = ads.buildConversionMessage({
    packageSlug: 'pro',
    language: 'nl',
    value: 540.006,
    orderId: 'tr_123',
    email: ' Buyer@Example.com '
  });
  assert.deepEqual(msg, {
    type: 'kiyoh_checkout_complete',
    package: 'pro',
    language: 'nl',
    value: 540.01,
    currency: 'EUR',
    orderId: 'tr_123',
    email: 'buyer@example.com'
  });
  assert.equal(typeof msg.value, 'number');
  // Pro yearly incl. 21% VAT would be 653.40. Ads must get the net figure.
  assert.notEqual(msg.value, 653.4);
});

test('buildConversionMessage omits a missing or invalid email', () => {
  const msg = ads.buildConversionMessage({
    packageSlug: 'go',
    language: 'en',
    value: '420.00',
    orderId: 'tr_9',
    email: 'not-an-email'
  });
  assert.equal(msg.email, undefined);
  assert.equal(msg.value, 420);
  assert.equal(JSON.stringify(msg).includes('@'), false);
});

test('shouldNotifyKiyohAds skips sales-portal, invoices, and other tenants', () => {
  assert.equal(ads.shouldNotifyKiyohAds({ packageSlug: 'go' }, 'kiyoh'), true);
  assert.equal(ads.shouldNotifyKiyohAds({ packageId: 'Pro' }, 'kiyoh'), true);
  assert.equal(ads.shouldNotifyKiyohAds({ packageSlug: 'go', source: 'sales-portal' }, 'kiyoh'), false);
  assert.equal(ads.shouldNotifyKiyohAds({ packageSlug: 'go', invoice_id: 'INV1' }, 'kiyoh'), false);
  assert.equal(ads.shouldNotifyKiyohAds({ packageSlug: 'go' }, 'klantenvertellen'), false);
});

test('order metadata keeps every click id; CRM webhook still sends one Google id', () => {
  const ids = ads.collectClickIds({
    gclid: 'Gclid',
    gbraid: 'Gbraid',
    wbraid: 'Wbraid',
    fbclid: 'Fbclid'
  });
  assert.deepEqual(ads.attributionMetadata(ids), {
    gclid: 'Gclid',
    gbraid: 'Gbraid',
    wbraid: 'Wbraid',
    fbclid: 'Fbclid'
  });
  const utms = ads.compactUtmsForMollie({
    utm_source: 'google',
    gclid: 'Gclid',
    gbraid: 'Gbraid',
    wbraid: 'Wbraid',
    fbclid: 'Fbclid'
  }, ids);
  assert.equal(utms.gclid, 'Gclid');
  assert.equal(utms.gbraid, 'Gbraid');
  assert.equal(utms.wbraid, 'Wbraid');
  assert.equal(utms.fbclid, 'Fbclid');

  const crm = require('./crm');
  const payload = crm.buildPayload({
    yearlyAmount: '508.20',
    yearlyAmountExVat: '420.00',
    packageId: 'Go',
    modulesList: '',
    utms,
    ...ids,
    customerName: 'Ada',
    businessName: 'Ada BV',
    customerEmail: 'ada@example.com'
  }, 'tr_ids');
  assert.equal(payload.gclid, 'Gclid');
  assert.equal(payload.gbraid, undefined);
  assert.equal(payload.wbraid, undefined);
  assert.equal(payload.utm.gclid, 'Gclid');
  assert.equal(payload.utm.gbraid, undefined);
  assert.equal(payload.utm.fbclid, 'Fbclid');
  assert.equal(payload.deal_waarde_ex_btw, '420.00');
});

test('success redirect URL carries click ids and the Mollie payment id', () => {
  const url = ads.buildSuccessRedirectUrl('https://payment.kiyoh.com', {
    orderId: 'tr_abc',
    tenant: 'kiyoh',
    clickIds: { gclid: 'G', gbraid: 'B', wbraid: 'W', fbclid: 'F' }
  });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://payment.kiyoh.com/success.html');
  assert.equal(parsed.searchParams.get('orderId'), 'tr_abc');
  assert.equal(parsed.searchParams.get('tenant'), 'kiyoh');
  assert.equal(parsed.searchParams.get('gclid'), 'G');
  assert.equal(parsed.searchParams.get('gbraid'), 'B');
  assert.equal(parsed.searchParams.get('wbraid'), 'W');
  assert.equal(parsed.searchParams.get('fbclid'), 'F');
});

test('success redirect URL drops trailing click ids before exceeding 1024 characters', () => {
  const orderId = 'tr_' + 'x'.repeat(800);
  const url = ads.buildSuccessRedirectUrl('https://payment.kiyoh.com', {
    orderId,
    tenant: 'kiyoh',
    clickIds: { gclid: 'G'.repeat(100), gbraid: 'B', wbraid: 'W', fbclid: 'F'.repeat(100) }
  });
  assert.ok(url.length <= 1024);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('orderId'), orderId);
  assert.equal(parsed.searchParams.get('gclid'), 'G'.repeat(100));
  assert.equal(parsed.searchParams.get('fbclid'), null);
});

test('fitMollieMetadata keeps the charged amounts and click ids under 1kB', () => {
  const meta = ads.fitMollieMetadata({
    tenant: 'kiyoh',
    packageId: 'Pro',
    packageSlug: 'pro',
    yearlyAmount: '653.40',
    yearlyAmountExVat: '540.00',
    customerEmail: 'ada@example.com',
    customerName: 'Ada Lovelace',
    gclid: 'G'.repeat(200),
    gbraid: 'B'.repeat(200),
    wbraid: 'W'.repeat(200),
    fbclid: 'F'.repeat(200),
    utms: {
      utm_source: 'google',
      user_agent: 'Mozilla/5.0 '.repeat(20),
      user_ip: '2001:db8::1',
      gclid: 'G'.repeat(200),
      gbraid: 'B'.repeat(200),
      wbraid: 'W'.repeat(200),
      fbclid: 'F'.repeat(200)
    }
  });
  assert.ok(Buffer.byteLength(JSON.stringify(meta), 'utf8') <= 1000);
  assert.equal(meta.yearlyAmount, '653.40');
  assert.equal(meta.yearlyAmountExVat, '540.00');
  assert.equal(meta.customerEmail, 'ada@example.com');
  assert.ok(meta.gclid);
  assert.ok(meta.fbclid);
});

test('checkout-complete posts only for a paid kiyoh order, with net value and email', () => {
  const paid = {
    id: 'tr_paid',
    status: 'paid',
    metadata: {
      tenant: 'kiyoh',
      packageSlug: 'pro',
      packageId: 'Pro',
      language: 'nl',
      yearlyAmount: '653.40',
      yearlyAmountExVat: '540.00',
      customerEmail: 'Buyer@Example.com',
      customerName: 'Ada',
      customerPhone: '0612345678',
      businessAddress: 'Keizersgracht 1'
    }
  };
  const ok = ads.buildCheckoutCompleteResponse(paid, 'kiyoh');
  assert.equal(ok.httpStatus, 200);
  assert.equal(ok.body.notify, true);
  assert.equal(ok.body.value, 540);
  assert.equal(typeof ok.body.value, 'number');
  assert.equal(ok.body.currency, 'EUR');
  assert.equal(ok.body.orderId, 'tr_paid');
  assert.equal(ok.body.package, 'pro');
  assert.equal(ok.body.email, 'buyer@example.com');
  assert.equal(ok.body.customerName, undefined);
  assert.equal(ok.body.customerPhone, undefined);
  assert.equal(JSON.stringify(ok.body).includes('0612'), false);
  assert.equal(JSON.stringify(ok.body).includes('Keizersgracht'), false);
  // Incl. VAT amount must not be the conversion value.
  assert.notEqual(ok.body.value, 653.4);

  for (const status of ['open', 'pending', 'authorized', 'failed', 'canceled', 'expired']) {
    const unpaid = ads.buildCheckoutCompleteResponse({ ...paid, status }, 'kiyoh');
    assert.equal(unpaid.httpStatus, 409, status);
    assert.equal(unpaid.body.notify, false);
    assert.equal(unpaid.body.status, status);
    assert.equal(unpaid.body.email, undefined);
  }

  const sales = ads.buildCheckoutCompleteResponse({
    ...paid,
    metadata: { ...paid.metadata, source: 'sales-portal' }
  }, 'kiyoh');
  assert.equal(sales.body.notify, false);
  assert.equal(sales.body.email, undefined);

  const invoice = ads.buildCheckoutCompleteResponse({
    ...paid,
    metadata: { ...paid.metadata, invoice_id: 'INV1' }
  }, 'kiyoh');
  assert.equal(invoice.body.notify, false);
});

test('unpaid retries are only for statuses that can still become paid', () => {
  assert.equal(ads.shouldRetryUnpaidStatus('open'), true);
  assert.equal(ads.shouldRetryUnpaidStatus('pending'), true);
  assert.equal(ads.shouldRetryUnpaidStatus('authorized'), true);
  assert.equal(ads.shouldRetryUnpaidStatus('failed'), false);
  assert.equal(ads.shouldRetryUnpaidStatus('canceled'), false);
  assert.equal(ads.shouldRetryUnpaidStatus('expired'), false);
  assert.equal(ads.shouldRetryUnpaidStatus('paid'), false);
});

test('success.html and the iframe relay target parent origins and do not load pixels', () => {
  const fs = require('fs');
  const success = fs.readFileSync(require('path').join(__dirname, 'public/success.html'), 'utf8');
  const appJs = fs.readFileSync(require('path').join(__dirname, 'public/app.js'), 'utf8');
  const index = fs.readFileSync(require('path').join(__dirname, 'public/index.html'), 'utf8');

  for (const origin of ads.KIYOH_PARENT_ORIGINS) {
    assert.ok(success.includes(origin), origin);
    assert.ok(appJs.includes(origin), origin);
  }
  assert.equal(success.includes("postMessage(payload, '*')"), false);
  assert.equal(success.includes('gtag('), false);
  assert.equal(success.includes('googletagmanager'), false);
  assert.equal(success.includes('fbq('), false);
  assert.equal(success.includes('connect.facebook.net'), false);
  assert.ok(success.includes('data.email'));
  assert.ok(success.includes(ads.CHECKOUT_CHANNEL));
  assert.ok(success.includes('sessionStorage'));
  assert.ok(success.includes('localStorage'));
  assert.ok(appJs.includes(ads.CHECKOUT_CHANNEL));
  assert.equal(index.includes('gtag('), false);
  assert.equal(index.includes('googletagmanager'), false);
  assert.equal(index.includes('fbq('), false);
  assert.deepEqual([...ads.KIYOH_PARENT_ORIGINS], [
    'https://kiyoh.com',
    'https://www.kiyoh.com',
    'https://kiyoh-com-production.up.railway.app'
  ]);
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
