const test = require('node:test');
const assert = require('node:assert');
const { newDb } = require('pg-mem');
const db = require('../db');

function mkPool() {
  const mem = newDb();
  mem.public.registerFunction({ name: 'pg_advisory_lock', args: ['int4'], returns: 'text', implementation: () => '' , impure: true});
  mem.public.registerFunction({ name: 'pg_advisory_unlock', args: ['int4'], returns: 'text', implementation: () => '', impure: true });
  const { Pool } = mem.adapters.createPg();
  return new Pool();
}

test('migration copies legacy row to kiyoh+kv, file to cz; per-tenant isolation; history', async () => {
  const p = mkPool();
  await p.query(`CREATE TABLE kiyoh_settings (id SERIAL PRIMARY KEY, config JSONB NOT NULL, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await p.query(`CREATE TABLE kiyoh_email_log (id SERIAL PRIMARY KEY, payment_id VARCHAR(50) NOT NULL, email_type VARCHAR(20) NOT NULL, recipient VARCHAR(255), status VARCHAR(20) NOT NULL, error TEXT, source VARCHAR(20), sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  const legacy = { packages: [{ id: 'go', price: 35 }], smtpTo: 'x@y.nl' };
  await p.query('INSERT INTO kiyoh_settings (config) VALUES ($1)', [{ old: true }]);
  await p.query('INSERT INTO kiyoh_settings (config) VALUES ($1)', [legacy]);
  await db.ensureTenantSchema(p);
  const cz = { currency: 'CZK', packages: [{ id: 'go', price: 690 }] };
  const done = await db.migrateTenantSettings({ kiyoh: { file: 1 }, klantenvertellen: { file: 2 }, 'kiyoh-cz': cz }, ['kiyoh', 'klantenvertellen'], p);
  assert.deepStrictEqual(done.map(d => d.source), ['legacy-db', 'legacy-db', 'file']);
  assert.deepStrictEqual(await db.loadTenantSettings('kiyoh', p), legacy);
  assert.deepStrictEqual(await db.loadTenantSettings('klantenvertellen', p), legacy);
  assert.deepStrictEqual(await db.loadTenantSettings('kiyoh-cz', p), cz);
  // idempotent
  assert.strictEqual((await db.migrateTenantSettings({ kiyoh: {} }, ['kiyoh'], p)).length, 0);
  // saving one tenant leaves the others alone
  await db.saveTenantSettings('klantenvertellen', { ...legacy, packages: [{ id: 'go', price: 99 }] }, { note: 'edit' }, p);
  assert.deepStrictEqual(await db.loadTenantSettings('kiyoh', p), legacy);
  assert.deepStrictEqual(await db.loadTenantSettings('kiyoh-cz', p), cz);
  assert.strictEqual((await db.loadTenantSettings('klantenvertellen', p)).packages[0].price, 99);
  // history + rollback source
  const h = await db.listTenantHistory('klantenvertellen', 10, p);
  assert.strictEqual(h.length, 2); assert.strictEqual(h[0].note, 'edit');
  const v = await db.getTenantVersion('klantenvertellen', h[1].id, p);
  assert.deepStrictEqual(v.config, legacy);
  assert.strictEqual(await db.getTenantVersion('kiyoh', h[1].id, p), null);
});

test('migration with empty legacy table seeds every tenant from file', async () => {
  const p = mkPool();
  await p.query(`CREATE TABLE kiyoh_settings (id SERIAL PRIMARY KEY, config JSONB NOT NULL)`);
  await p.query(`CREATE TABLE kiyoh_email_log (id SERIAL PRIMARY KEY, payment_id VARCHAR(50) NOT NULL, email_type VARCHAR(20) NOT NULL, recipient VARCHAR(255), status VARCHAR(20) NOT NULL, error TEXT, source VARCHAR(20), sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  await db.ensureTenantSchema(p);
  const done = await db.migrateTenantSettings({ kiyoh: { a: 1 } }, ['kiyoh'], p);
  assert.strictEqual(done[0].source, 'file');
  assert.deepStrictEqual(await db.loadTenantSettings('kiyoh', p), { a: 1 });
});
