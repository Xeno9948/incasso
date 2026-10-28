const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

let pool = null;
let readyResolve; const ready = new Promise(r => { readyResolve = r; });

if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });

  // Initialize DB table
  const initDb = async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS kiyoh_settings (
          id SERIAL PRIMARY KEY,
          config JSONB NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS kiyoh_processed_payments (
          payment_id VARCHAR(50) PRIMARY KEY,
          processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS kiyoh_email_log (
          id SERIAL PRIMARY KEY,
          payment_id VARCHAR(50) NOT NULL,
          email_type VARCHAR(20) NOT NULL,
          recipient VARCHAR(255),
          status VARCHAR(20) NOT NULL,
          error TEXT,
          source VARCHAR(20) DEFAULT 'webhook',
          sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_kiyoh_email_log_payment
        ON kiyoh_email_log (payment_id, sent_at DESC);
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS kiyoh_deal_overrides (
          payment_id VARCHAR(50) PRIMARY KEY,
          overrides JSONB NOT NULL,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await ensureTenantSchema(pool);
      console.log('Database initialized successfully.');
    } catch (err) {
      console.error('Failed to initialize database:', err);
    }
    readyResolve();
  };
  initDb();
} else {
  readyResolve();
}

// ─── PER-TENANT SETTINGS (versioned) ─────────────────────────────────────
// One row per saved version; the newest row per tenant is the live config.
// The legacy single-row table kiyoh_settings is left untouched (backup) and
// still mirrors the kiyoh tenant, so a code rollback keeps working.
async function ensureTenantSchema(p) {
  await p.query(`
    CREATE TABLE IF NOT EXISTS kiyoh_tenant_settings (
      id SERIAL PRIMARY KEY,
      tenant VARCHAR(64) NOT NULL,
      config JSONB NOT NULL,
      note TEXT,
      source VARCHAR(40),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`);
  await p.query(`CREATE INDEX IF NOT EXISTS idx_kiyoh_tenant_settings ON kiyoh_tenant_settings (tenant, id DESC);`);
  await p.query(`ALTER TABLE kiyoh_email_log ADD COLUMN IF NOT EXISTS tenant VARCHAR(64);`);
  await p.query(`ALTER TABLE kiyoh_email_log ALTER COLUMN email_type TYPE VARCHAR(40);`);
}

/**
 * Seed per-tenant rows once. tenants: { id: fileConfig }. Tenants listed in
 * legacyTenants get the current legacy DB row (that is what they serve today);
 * the rest get their file config. Tenants that already have rows are skipped.
 */
async function migrateTenantSettings(seeds, legacyTenants, p = pool) {
  if (!p) return [];
  const client = p.connect ? await p.connect() : p;
  const done = [];
  try {
    if (client !== p) await client.query('SELECT pg_advisory_lock(424242)');
    let legacy;
    for (const [tenant, fileCfg] of Object.entries(seeds)) {
      const has = await client.query('SELECT 1 FROM kiyoh_tenant_settings WHERE tenant = $1 LIMIT 1', [tenant]);
      if (has.rows.length) continue;
      let cfg = fileCfg, source = 'file';
      if (legacyTenants.includes(tenant)) {
        if (legacy === undefined) {
          const r = await client.query('SELECT config FROM kiyoh_settings ORDER BY id DESC LIMIT 1');
          legacy = r.rows.length ? r.rows[0].config : null;
        }
        if (legacy) { cfg = legacy; source = 'legacy-db'; }
      }
      await client.query('INSERT INTO kiyoh_tenant_settings (tenant, config, note, source) VALUES ($1, $2, $3, $4)',
        [tenant, cfg, 'Initial migration (' + source + ')', 'migration']);
      done.push({ tenant, source });
    }
  } finally {
    if (client !== p) { await client.query('SELECT pg_advisory_unlock(424242)'); client.release(); }
  }
  return done;
}

async function loadTenantSettings(tenant, p = pool) {
  if (!p) return null;
  const r = await p.query('SELECT config FROM kiyoh_tenant_settings WHERE tenant = $1 ORDER BY id DESC LIMIT 1', [tenant]);
  return r.rows.length ? r.rows[0].config : null;
}

async function saveTenantSettings(tenant, config, { note, source } = {}, p = pool) {
  if (!p) return null;
  const r = await p.query('INSERT INTO kiyoh_tenant_settings (tenant, config, note, source) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
    [tenant, config, note || null, source || 'admin']);
  await p.query(`DELETE FROM kiyoh_tenant_settings WHERE tenant = $1 AND id NOT IN
    (SELECT id FROM kiyoh_tenant_settings WHERE tenant = $1 ORDER BY id DESC LIMIT 100)`, [tenant]);
  return r.rows[0];
}

async function listTenantHistory(tenant, limit = 50, p = pool) {
  if (!p) return [];
  const r = await p.query('SELECT id, note, source, created_at FROM kiyoh_tenant_settings WHERE tenant = $1 ORDER BY id DESC LIMIT $2', [tenant, limit]);
  return r.rows;
}

async function getTenantVersion(tenant, id, p = pool) {
  if (!p) return null;
  const r = await p.query('SELECT id, config, note, source, created_at FROM kiyoh_tenant_settings WHERE tenant = $1 AND id = $2', [tenant, id]);
  return r.rows[0] || null;
}

async function getEmailLogForTenant(tenant, limit = 100, p = pool) {
  if (!p) return [];
  const r = await p.query(`SELECT payment_id, email_type, recipient, status, error, source, sent_at, tenant
     FROM kiyoh_email_log WHERE tenant = $1 OR ($1 = 'kiyoh' AND tenant IS NULL)
     ORDER BY sent_at DESC LIMIT $2`, [tenant, limit]);
  return r.rows;
}

/**
 * Load settings from DB or fallback to file
 */
async function loadSettings(fallbackConfig) {
  if (!pool) return fallbackConfig;

  try {
    const res = await pool.query('SELECT config FROM kiyoh_settings ORDER BY id DESC LIMIT 1');
    if (res.rows.length > 0) {
      return res.rows[0].config;
    }
    
    // If table is empty, seed it with fallback config
    await saveSettings(fallbackConfig);
    return fallbackConfig;
  } catch (err) {
    console.error('Error loading settings from DB:', err);
    return fallbackConfig;
  }
}

/**
 * Save settings to DB
 */
async function saveSettings(config) {
  if (!pool) return false;

  try {
    // We only keep one row (the latest)
    await pool.query('INSERT INTO kiyoh_settings (config) VALUES ($1)', [config]);
    // Optional: Clean up old rows to keep DB small
    await pool.query('DELETE FROM kiyoh_settings WHERE id NOT IN (SELECT id FROM kiyoh_settings ORDER BY id DESC LIMIT 5)');
    return true;
  } catch (err) {
    console.error('Error saving settings to DB:', err);
    return false;
  }
}

const processedCache = new Set();

/**
 * Check if a payment ID has already been successfully processed
 */
async function isPaymentProcessed(paymentId) {
  if (processedCache.has(paymentId)) return true;
  if (!pool) return false;

  try {
    const res = await pool.query('SELECT 1 FROM kiyoh_processed_payments WHERE payment_id = $1', [paymentId]);
    if (res.rows.length > 0) {
      processedCache.add(paymentId);
      return true;
    }
    return false;
  } catch (err) {
    console.error('Error checking processed payment:', err);
    return false;
  }
}

/**
 * Atomically claim a payment for processing.
 * Returns true if THIS caller should run fulfillment (row inserted).
 * Returns false if another request already claimed/processed it.
 * Without a DB pool, falls back to the in-memory cache only.
 */
async function tryClaimPayment(paymentId) {
  if (processedCache.has(paymentId)) return false;
  if (!pool) {
    if (processedCache.has(paymentId)) return false;
    processedCache.add(paymentId);
    return true;
  }

  try {
    const res = await pool.query(
      'INSERT INTO kiyoh_processed_payments (payment_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING payment_id',
      [paymentId]
    );
    if (res.rowCount > 0) {
      processedCache.add(paymentId);
      return true;
    }
    processedCache.add(paymentId);
    return false;
  } catch (err) {
    console.error('Error claiming payment for processing:', err);
    // Fail open only if we cannot tell — caller should still be careful
    return !processedCache.has(paymentId);
  }
}

/**
 * Record a payment ID as successfully processed (legacy / admin use).
 */
async function markPaymentProcessed(paymentId) {
  processedCache.add(paymentId);
  if (!pool) return true;

  try {
    await pool.query('INSERT INTO kiyoh_processed_payments (payment_id) VALUES ($1) ON CONFLICT DO NOTHING', [paymentId]);
    return true;
  } catch (err) {
    console.error('Error marking payment processed:', err);
    return false;
  }
}

/**
 * Release a claim so Mollie retries (or a later webhook) can re-run
 * fulfillment after a partial failure (CRM/mail down, etc.).
 */
async function unmarkPaymentProcessed(paymentId) {
  processedCache.delete(paymentId);
  if (!pool) return true;

  try {
    await pool.query('DELETE FROM kiyoh_processed_payments WHERE payment_id = $1', [paymentId]);
    return true;
  } catch (err) {
    console.error('Error unmarking payment processed:', err);
    return false;
  }
}

/**
 * Email log helpers — tracks every internal/customer/accountant
 * email send tied to a Mollie payment so the admin UI can show
 * what was sent, when, and whether it succeeded.
 */
async function logEmail({ paymentId, type, recipient, status, error, source, tenant }) {
  if (!pool) return null;
  try {
    const res = await pool.query(
      `INSERT INTO kiyoh_email_log (payment_id, email_type, recipient, status, error, source, tenant)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, sent_at`,
      [paymentId, type, recipient || null, status, error || null, source || 'webhook', tenant || null]
    );
    return res.rows[0];
  } catch (err) {
    console.error('Error writing email log:', err.message);
    return null;
  }
}

async function getEmailLogForPayments(paymentIds) {
  if (!pool || !paymentIds.length) return {};
  try {
    const res = await pool.query(
      `SELECT payment_id, email_type, recipient, status, error, source, sent_at
       FROM kiyoh_email_log
       WHERE payment_id = ANY($1::varchar[])
       ORDER BY sent_at DESC`,
      [paymentIds]
    );
    const out = {};
    for (const row of res.rows) {
      (out[row.payment_id] = out[row.payment_id] || []).push(row);
    }
    return out;
  } catch (err) {
    console.error('Error reading email log:', err.message);
    return {};
  }
}

/**
 * True if this payment already has a successful (or intentionally skipped)
 * log row for the given email_type. Used so webhook retries don't double-send.
 */
async function hasSuccessfulSend(paymentId, type) {
  if (!pool) return false;
  try {
    // 'skipped' for missing SMTP must not block retries once SMTP is configured.
    // Intentional product skips (e.g. sales-portal) still count as done.
    const res = await pool.query(
      `SELECT 1 FROM kiyoh_email_log
       WHERE payment_id = $1 AND email_type = $2
         AND (
           status = 'sent'
           OR (status = 'skipped' AND COALESCE(error, '') <> 'SMTP not configured')
         )
       LIMIT 1`,
      [paymentId, type]
    );
    return res.rows.length > 0;
  } catch (err) {
    console.error('Error checking successful send:', err.message);
    return false;
  }
}

/**
 * Deal metadata overrides — saved per Mollie payment_id and merged on
 * top of payment.metadata whenever the admin reads a deal, resends a
 * mail, or downloads the opdrachtformulier. Used to backfill fields
 * (KVK, BTW, address, etc.) for deals paid before those fields existed.
 */
async function getDealOverrides(paymentId) {
  if (!pool) return {};
  try {
    const res = await pool.query(
      `SELECT overrides FROM kiyoh_deal_overrides WHERE payment_id = $1`,
      [paymentId]
    );
    return res.rows[0] ? res.rows[0].overrides : {};
  } catch (err) {
    console.error('Error reading deal overrides:', err.message);
    return {};
  }
}

async function getDealOverridesBatch(paymentIds) {
  if (!pool || !paymentIds.length) return {};
  try {
    const res = await pool.query(
      `SELECT payment_id, overrides FROM kiyoh_deal_overrides
       WHERE payment_id = ANY($1::varchar[])`,
      [paymentIds]
    );
    const out = {};
    for (const row of res.rows) out[row.payment_id] = row.overrides;
    return out;
  } catch (err) {
    console.error('Error reading deal overrides batch:', err.message);
    return {};
  }
}

async function saveDealOverrides(paymentId, overrides) {
  if (!pool) return false;
  try {
    await pool.query(
      `INSERT INTO kiyoh_deal_overrides (payment_id, overrides, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (payment_id) DO UPDATE
         SET overrides = EXCLUDED.overrides, updated_at = NOW()`,
      [paymentId, overrides]
    );
    return true;
  } catch (err) {
    console.error('Error saving deal overrides:', err.message);
    return false;
  }
}

module.exports = {
  ready,
  ensureTenantSchema,
  migrateTenantSettings,
  loadTenantSettings,
  saveTenantSettings,
  listTenantHistory,
  getTenantVersion,
  getEmailLogForTenant,
  loadSettings,
  saveSettings,
  isPaymentProcessed,
  markPaymentProcessed,
  tryClaimPayment,
  unmarkPaymentProcessed,
  logEmail,
  getEmailLogForPayments,
  hasSuccessfulSend,
  getDealOverrides,
  getDealOverridesBatch,
  saveDealOverrides,
  isDbEnabled: !!pool
};
