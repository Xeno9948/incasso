const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

let pool = null;

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
      console.log('Database initialized successfully.');
    } catch (err) {
      console.error('Failed to initialize database:', err);
    }
  };
  initDb();
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
 * Record a payment ID as successfully processed
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
 * Email log helpers — tracks every internal/customer/accountant
 * email send tied to a Mollie payment so the admin UI can show
 * what was sent, when, and whether it succeeded.
 */
async function logEmail({ paymentId, type, recipient, status, error, source }) {
  if (!pool) return null;
  try {
    const res = await pool.query(
      `INSERT INTO kiyoh_email_log (payment_id, email_type, recipient, status, error, source)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, sent_at`,
      [paymentId, type, recipient || null, status, error || null, source || 'webhook']
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

module.exports = {
  loadSettings,
  saveSettings,
  isPaymentProcessed,
  markPaymentProcessed,
  logEmail,
  getEmailLogForPayments,
  isDbEnabled: !!pool
};
