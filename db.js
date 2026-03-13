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

module.exports = {
  loadSettings,
  saveSettings,
  isDbEnabled: !!pool
};
