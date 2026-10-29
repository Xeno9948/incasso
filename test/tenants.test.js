const test = require('node:test');
const assert = require('node:assert');
const t = require('../tenants');

test('notifications defaults reproduce legacy behaviour', () => {
  const n = t.getNotifications({ smtpTo: 'ops@x.nl' });
  assert.deepStrictEqual(n.cc, ['xeno@kiyoh.com']);
  assert.deepStrictEqual(n.events.order.recipients, ['ops@x.nl']);
  assert.deepStrictEqual(n.events.dealPaid.recipients, ['ops@x.nl']);
  assert.deepStrictEqual(n.events.signup.recipients, []);
  assert.strictEqual(n.events.cancellation.enabled, false);
  assert.deepStrictEqual(t.getNotifications({}).events.order.recipients, ['info@klantenvertellen.nl']);
  const r = t.resolveRecipients({}, 'order');
  assert.strictEqual(r.to, 'info@klantenvertellen.nl'); assert.strictEqual(r.bcc, 'xeno@kiyoh.com');
});

test('explicit notifications override defaults', () => {
  const r = t.resolveRecipients({ notifications: { cc: 'a@b.cz; c@d.cz', events: { order: { recipients: ['cz@kiyoh.com'] } } } }, 'order');
  assert.strictEqual(r.to, 'cz@kiyoh.com'); assert.strictEqual(r.bcc, 'a@b.cz, c@d.cz');
  assert.strictEqual(t.resolveRecipients({ notifications: { cc: [] } }, 'order').bcc, '');
});

test('mollie key order unchanged, optional custom env first', () => {
  const env = { MOLLIE_LIVE_KEY: 'live_g', MOLLIE_LIVE_KEY_KIYOH_CZ: 'live_cz', MOLLIE_API_KEY: 'test_api' };
  assert.strictEqual(t.resolveMollieKey({}, 'kiyoh-cz', env, false).key, 'live_cz');
  assert.strictEqual(t.resolveMollieKey({}, 'kiyoh', env, false).key, 'live_g');
  assert.strictEqual(t.resolveMollieKey({}, 'kiyoh', env, true).key, 'test_api');
  assert.strictEqual(t.resolveMollieKey({ mollieTestKey: 'test_cfg' }, 'kiyoh', {}, true).key, 'test_cfg');
  assert.strictEqual(t.resolveMollieKey({ payment: { liveKeyEnv: 'MY_KEY' } }, 'kiyoh', { ...env, MY_KEY: 'live_mine' }, false).source, 'env:MY_KEY');
  const st = t.paymentStatus({ mollieTestMode: false }, 'kiyoh', env);
  assert.strictEqual(st.liveKeyPresent, true); assert.ok(!JSON.stringify(st).includes('live_g'));
});

test('copySections copies only chosen sections, deep', () => {
  const src = { packages: [{ id: 'go', price: 35 }], modules: [1], vatPercentage: 21 };
  const dst = { packages: [], modules: [2], vatPercentage: 0, currency: 'CZK' };
  const out = t.copySections(dst, src, ['packages']);
  assert.deepStrictEqual(out.packages, src.packages); assert.deepStrictEqual(out.modules, [2]);
  out.packages[0].price = 1; assert.strictEqual(src.packages[0].price, 35);
});

test('webhook signature is HMAC-SHA256', () => {
  const sig = t.signWebhook('{"a":1}', 's');
  assert.strictEqual(sig, require('crypto').createHmac('sha256', 's').update('{"a":1}').digest('hex'));
  assert.strictEqual(t.signWebhook('x', ''), '');
});
