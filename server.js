const express = require('express');
const { createMollieClient } = require('@mollie/api-client');
const cors = require('cors');
const QRCode = require('qrcode');
const exact = require('./exact');
const kiyoh = require('./kiyoh');
const opdracht = require('./opdracht');
const { rateLimit } = require('express-rate-limit');
const { TOTP, NobleCryptoPlugin, ScureBase32Plugin } = require('otplib');
const nodemailer = require('nodemailer');
const authenticator = new TOTP({
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin()
});

const fs = require('fs');
const path = require('path');
const db = require('./db');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

// ─── SMTP EMAIL HELPER ────────────────────────────────────────────────────────
async function getSmtpTransporter() {
  const config = await getConfig();

  const smtpHost = config.smtpHost || process.env.SMTP_HOST;
  const smtpPort = parseInt(config.smtpPort || process.env.SMTP_PORT || '465', 10);
  const smtpUser = config.smtpUser || process.env.SMTP_USER;
  const smtpPass = config.smtpPass || process.env.SMTP_PASS;
  const smtpFrom = config.smtpFrom || smtpUser;
  const smtpTo   = config.smtpTo   || 'info@klantenvertellen.nl';

  if (!smtpHost || !smtpUser || !smtpPass) return null;

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass }
  });

  return { transporter, from: `"Kiyoh Betalingen" <${smtpFrom}>`, to: smtpTo };
}

async function sendInternalNotification(metadata) {
  const mailer = await getSmtpTransporter();
  if (!mailer) {
    console.log('SMTP not configured — skipping internal notification email.');
    return;
  }

  const { customerName, businessName, website, customerEmail, customerPhone,
          packageId, yearlyAmount, modulesList, description,
          businessAddress, businessPostal, businessCity, businessCountry, kvkNumber } = metadata;

  const moduleArr = (modulesList || '').split(',').map(s => s.trim()).filter(Boolean);
  const hasExtraModules = moduleArr.length > 0;

  const extraModulesBlock = hasExtraModules ? `
        <div style="margin-top:24px;padding:16px;background:#fff3cd;border:1px solid #ffe69c;border-radius:8px;">
          <strong style="color:#7a5b00;">⚠️ Extra modules nog activeren</strong>
          <p style="margin:8px 0 0;color:#5a4400;font-size:14px;">
            Deze klant heeft de volgende extra modules afgenomen die nog handmatig aangezet moeten worden in het Kiyoh-platform:
          </p>
          <ul style="margin:8px 0 0;color:#5a4400;font-size:14px;">
            ${moduleArr.map(m => `<li>${m}</li>`).join('')}
          </ul>
        </div>
      ` : '';

  const kiyohBlock = '';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#f58220;padding:24px 32px;border-radius:10px 10px 0 0;">
        <h2 style="color:white;margin:0;">✅ Nieuw abonnement afgesloten</h2>
      </div>
      <div style="background:#fff;border:1px solid #eee;border-top:none;padding:32px;border-radius:0 0 10px 10px;">
        <h3 style="color:#1a1a1a;margin-top:0;">Klantgegevens</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:10px 0;color:#888;width:180px;">Contactpersoon</td><td style="padding:10px 0;font-weight:600;">${customerName || '—'}</td></tr>
          <tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:10px 0;color:#888;">Bedrijfsnaam</td><td style="padding:10px 0;font-weight:600;">${businessName || '—'}</td></tr>
          <tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:10px 0;color:#888;">KVK-nummer</td><td style="padding:10px 0;font-weight:600;">${kvkNumber || '—'}</td></tr>
          <tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:10px 0;color:#888;">Adres</td><td style="padding:10px 0;">${businessAddress || '—'}</td></tr>
          <tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:10px 0;color:#888;">Postcode</td><td style="padding:10px 0;">${businessPostal || '—'}</td></tr>
          <tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:10px 0;color:#888;">Plaats</td><td style="padding:10px 0;">${businessCity || '—'}</td></tr>
          <tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:10px 0;color:#888;">Land</td><td style="padding:10px 0;">${businessCountry || '—'}</td></tr>
          <tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:10px 0;color:#888;">E-mail</td><td style="padding:10px 0;"><a href="mailto:${customerEmail}">${customerEmail || '—'}</a></td></tr>
          <tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:10px 0;color:#888;">Telefoon</td><td style="padding:10px 0;">${customerPhone || '—'}</td></tr>
          <tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:10px 0;color:#888;">Website</td><td style="padding:10px 0;"><a href="${website}">${website || '—'}</a></td></tr>
        </table>

        <h3 style="color:#1a1a1a;margin-top:24px;">Pakketgegevens</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:10px 0;color:#888;width:180px;">Pakket</td><td style="padding:10px 0;font-weight:600;">${packageId || '—'}</td></tr>
          <tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:10px 0;color:#888;">Modules</td><td style="padding:10px 0;">${modulesList || 'Geen extra modules'}</td></tr>
          <tr style="border-bottom:1px solid #f0f0f0;"><td style="padding:10px 0;color:#888;">Jaarbedrag</td><td style="padding:10px 0;font-weight:600;color:#68b03d;">€${yearlyAmount || '—'}</td></tr>
          <tr><td style="padding:10px 0;color:#888;">Omschrijving</td><td style="padding:10px 0;">${description || '—'}</td></tr>
        </table>
        ${extraModulesBlock}
        ${kiyohBlock}

        <div style="margin-top:24px;padding:16px;background:#f9f9f9;border-radius:8px;font-size:12px;color:#aaa;">
          Dit is een automatisch bericht van het Kiyoh betalingssysteem.
        </div>
      </div>
    </div>
  `;

  await mailer.transporter.sendMail({
    from: mailer.from,
    to: mailer.to,
    subject: `✅ Nieuw abonnement: ${businessName || customerName} — ${packageId}`,
    html
  });

  console.log(`Internal notification email sent to ${mailer.to}`);
}

async function sendCustomerWelcome(metadata, signupUrl) {
  const mailer = await getSmtpTransporter();
  if (!mailer || !metadata.customerEmail) return;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#f58220;padding:24px 32px;border-radius:10px 10px 0 0;">
        <h2 style="color:white;margin:0;">Welkom bij Kiyoh!</h2>
      </div>
      <div style="background:#fff;border:1px solid #eee;border-top:none;padding:32px;border-radius:0 0 10px 10px;font-size:14px;color:#333;">
        <p>Hi ${metadata.customerName || ''},</p>
        <p>Bedankt voor je aanmelding voor het <strong>${metadata.packageId}</strong>-pakket. Je betaling is binnen.</p>
        ${signupUrl ? `
          <p>Maak nu in één minuut je account aan — je gegevens staan al voor je klaar:</p>
          <p style="text-align:center;margin:24px 0;">
            <a href="${signupUrl}" style="background:#f58220;color:white;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;display:inline-block;">Account aanmaken</a>
          </p>
          <p style="font-size:12px;color:#888;word-break:break-all;">Of plak deze link in je browser: ${signupUrl}</p>
        ` : `
          <p>Ons team neemt binnen 1 werkdag contact op om je account in te richten.</p>
        `}
        <p>Vragen? Reageer gewoon op deze mail.</p>
        <p style="margin-top:24px;">— Het Kiyoh team</p>
      </div>
    </div>
  `;

  await mailer.transporter.sendMail({
    from: mailer.from,
    to: metadata.customerEmail,
    subject: 'Welkom bij Kiyoh — maak je account aan',
    html
  });

  console.log(`Customer welcome email sent to ${metadata.customerEmail}`);
}

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');
const CONFIG_EXAMPLE_PATH = path.join(__dirname, 'config.example.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'kiyoh-admin-2024';

const app = express();
const port = process.env.PORT || 3000;

// Helper to read config with fallback
async function getConfig() {
  let localConfig = { packages: [], modules: [], coreFeatures: [] };
  
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      localConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } else if (fs.existsSync(CONFIG_EXAMPLE_PATH)) {
      console.log('Using example config fallback');
      localConfig = JSON.parse(fs.readFileSync(CONFIG_EXAMPLE_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('Error reading local config:', err);
  }

  // Load from DB if available, otherwise return local config
  return await db.loadSettings(localConfig);
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Rate Limiting for sensitive routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 requests per window
  message: { error: 'Too many requests, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Authentication Middleware
const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Helper to get Mollie Client dynamically
async function getMollieClient() {
  const config = await getConfig();
  const testMode = config.mollieTestMode !== false; // Default to true if not specified
  
  // Priority: 1. Env Var, 2. Config, 3. Hardcoded Test Key
  const liveKey = process.env.MOLLIE_LIVE_KEY || config.mollieLiveKey;
  const testKey = process.env.MOLLIE_TEST_KEY || config.mollieTestKey || 'test_hzHT8sHqADu26Dwmnt36Fu3Wmc5DfD';
  
  const apiKey = testMode ? testKey : liveKey;
  
  if (!apiKey) {
    console.error('MOLLIE ERROR: No API Key found for mode:', testMode ? 'TEST' : 'LIVE');
  }

  return createMollieClient({ apiKey: apiKey });
}

// Setup Config API Routes
app.get('/api/config', async (req, res) => {
  res.json(await getConfig());
});

app.post('/api/auth', authLimiter, async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const config = await getConfig();
  if (config.twoFactorEnabled && config.twoFactorSecret) {
    return res.json({ ok: true, twoFactorRequired: true });
  }
  
  res.json({ ok: true, twoFactorRequired: false });
});

app.post('/api/auth/2fa', authLimiter, async (req, res) => {
  const { password, code } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  
  const config = await getConfig();
  if (!config.twoFactorEnabled || !config.twoFactorSecret) {
    return res.status(400).json({ error: '2FA not enabled' });
  }
  
  const isValid = await authenticator.verify(code, {
    secret: config.twoFactorSecret
  });
  
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid 2FA code' });
  }
  
  res.json({ ok: true });
});

app.get('/api/2fa/setup', authMiddleware, async (req, res) => {
  const secret = authenticator.generateSecret();
  const otpauth = authenticator.toURI({ label: 'Admin', issuer: 'Kiyoh-Pricing', secret });
  
  try {
    const qrCodeUrl = await QRCode.toDataURL(otpauth);
    res.json({ secret, qrCodeUrl });
  } catch (err) {
    res.status(500).json({ error: 'Failed to generate QR code' });
  }
});

app.post('/api/2fa/verify', authMiddleware, async (req, res) => {
  const { secret, code } = req.body;
  const isValid = await authenticator.verify(code, { secret });
  
  if (!isValid) {
    return res.status(401).json({ error: 'Invalid code' });
  }
  
  const config = await getConfig();
  config.twoFactorSecret = secret;
  config.twoFactorEnabled = true;
  
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    await db.saveSettings(config);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

app.post('/api/2fa/disable', authMiddleware, async (req, res) => {
  const config = await getConfig();
  config.twoFactorEnabled = false;
  config.twoFactorSecret = null;
  
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    await db.saveSettings(config);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

app.post('/api/config', authLimiter, authMiddleware, async (req, res) => {
  const { password, ...config } = req.body;
  // password in body is now optional since it's checked in header, 
  // but we keep it for backward compatibility if needed, though middleware already checked headers.
  try {
    // 1. Save to local file (for local dev/backups)
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    
    // 2. Save to Database (for Railway persistence)
    await db.saveSettings(config);
    
    res.json({ success: true, db: db.isDbEnabled });
  } catch (err) {
    console.error('Save error:', err);
    res.status(500).json({ error: 'Could not save config' });
  }
});

// Setup Image Upload API Route
app.post('/api/upload', authMiddleware, async (req, res) => {
  try {
    const { fileName, fileType, base64Data } = req.body;
    if (!fileName || !base64Data) {
      return res.status(400).json({ error: 'Missing fileName or base64Data' });
    }

    // Extract the raw base64 data (strip prefix like data:image/png;base64,)
    const base64Content = base64Data.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(base64Content, 'base64');

    const uploadDir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    // Clean up filename and append timestamp
    const ext = path.extname(fileName) || '.png';
    const name = path.basename(fileName, ext).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const uniqueFileName = `${name}-${Date.now()}${ext}`;
    const filePath = path.join(uploadDir, uniqueFileName);

    await fs.promises.writeFile(filePath, buffer);
    
    // Return relative URL
    res.json({ success: true, url: `/uploads/${uniqueFileName}` });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to upload image: ' + err.message });
  }
});

// Setup Checkout API Route
app.post('/api/checkout', async (req, res) => {
  try {
    const { package, modules, customer, utms } = req.body;

    // Get client IP for UTMs if possible
    const user_ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (utms) utms.user_ip = user_ip;

    // Create a copy of utms for Mollie metadata and truncate user_agent to stay safely under Mollie's 1kB limit
    const mollieUtms = utms ? { ...utms } : {};
    if (mollieUtms.user_agent) {
      mollieUtms.user_agent = mollieUtms.user_agent.substring(0, 70);
    }

    // Load config for dynamic settings
    const config = await getConfig();

    const methods = config.mollieMethods ? config.mollieMethods.split(',').map(m => m.trim()) : ['ideal', 'creditcard', 'bancontact'];
    const interval = config.mollieInterval || '12 months';
    let descriptionTemplate = config.mollieDescription || 'Kiyoh Abonnement: {PACKAGE}';

    // VERY IMPORTANT: Calculate total on the backend to prevent tampering
    let calculatedTotal = package.price;
    let modulesStr = modules && modules.length > 0 ? modules.map(m => m.name).join(', ') : 'Geen';
    
    // Replace template tags
    descriptionTemplate = descriptionTemplate.replace('{PACKAGE}', package.name).replace('{LEVEL}', modulesStr);
    let descriptionStr = descriptionTemplate;

    if (modules && modules.length > 0) {
      modules.forEach(m => {
        // Enforce dynamic pricing for Productreviews (60% of package price)
        if (m.name === 'Productreviews' || m.id === 'productreviews') {
          m.price = package.price * 0.6;
        }
        calculatedTotal += m.price;
        descriptionStr += `, Module: ${m.name}`;
      });
    }

    // Advertising is monthly, but billing is yearly
    const yearlyTotal = calculatedTotal * 12;
    const amountStr = yearlyTotal.toFixed(2);

    // 1. Create a Mollie Customer
    const mollieClient = await getMollieClient();
    const mollieCustomer = await mollieClient.customers.create({
      name: `${customer.pName} (${customer.bName})`,
      email: customer.email,
    });

    // Determine base URL dynamically (Railway uses https by default)
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const baseUrl = `${protocol}://${req.headers.host}`;

    // 2. Create the FIRST payment to obtain a mandate
    const isRecurring = config.molliePaymentType !== 'once';
    const sequenceType = isRecurring ? 'first' : 'oneoff';

    const payment = await mollieClient.payments.create({
      amount: {
        value: amountStr,
        currency: 'EUR'
      },
      customerId: mollieCustomer.id,
      sequenceType: sequenceType,
      method: methods,
      description: `Eerste verificatiebetaling voor ${descriptionStr}`,
      redirectUrl: `${baseUrl}/success.html`,
      cancelUrl: `${baseUrl}/cancel.html`,
      webhookUrl: `${baseUrl}/api/webhook`, 
      billingAddress: {
        streetAndNumber: customer.address,
        postalCode: customer.postal,
        city: customer.city,
        country: customer.country
      },
      metadata: {
        packageId: package.name,
        yearlyAmount: amountStr,
        description: descriptionStr,
        customerName: customer.pName,
        businessName: customer.bName,
        website: customer.website,
        customerEmail: customer.email,
        customerPhone: customer.phone || '',
        businessAddress: customer.address,
        businessPostal: customer.postal,
        businessCity: customer.city,
        businessCountry: customer.country,
        kvkNumber: customer.kvk,
        btwNumber: customer.btw || '',
        modulesList: modules && modules.length > 0 ? modules.map(m => m.name).join(', ') : '',
        utms: mollieUtms
      }
    });

    // Send the payment link back to the frontend
    res.json({ checkoutUrl: payment.getCheckoutUrl() });

    // ─── FIRE CRM WEBHOOK (OPVOLGEN) ──────────────────────────────────
    // Send to CRM immediately so we have the lead even if they abandon Mollie checkout
    try {
      const config = await getConfig();

      const crmUrl = config.crmWebhookUrl || process.env.CRM_WEBHOOK_URL;
      if (crmUrl) {
        console.log('Sending abandoned cart lead to CRM webhook:', crmUrl);
        // Fire in background, don't await
        
        // Build an explicit message with selected package & modules
        const selectedModules = modules && modules.length > 0 ? modules.map(m => m.name).join(', ') : 'Geen extra modules';
        const explicitMessage = `Pakket geselecteerd: ${package.name}\nModules geselecteerd: ${selectedModules}\nAdres: ${customer.address}\nPostcode: ${customer.postal}\nPlaats: ${customer.city}\nLand: ${customer.country}\nKVK: ${customer.kvk}`;

        fetch(crmUrl, {
          method: 'POST',
          headers: { 
            'Content-Type': 'application/json',
            'User-Agent': 'Kiyoh-Webhook-Client/1.0'
          },
          body: JSON.stringify({
            aanmelding_type: "Kiyoh Online Abonnement",
            bedrijf: customer.bName,
            contactpersoon: customer.pName,
            website: customer.website || '',
            telefoon: customer.phone || '',
            email: customer.email,
            collega: "Systeem",
            status: "Opvolgen",
            upsell: "NB",
            product: "Kiyoh",
            message: explicitMessage,
            feature: package.name,
            deal_waarde: amountStr,
            kvk: customer.kvk,
            adres: customer.address,
            postcode: customer.postal,
            plaats: customer.city,
            land: customer.country,
            source: utms ? (utms.utm_source || utms.source || 'website') : 'website',
            external_id: payment.id,
            utm: utms || {}
          })
        }).catch(e => console.error('Error sending abandoned cart webhook:', e));
      }
    } catch (err) {
      console.error('Failed to send abandoned cart CRM webhook:', err);
    }

  } catch (error) {
    console.error('Failed to create Mollie payment:', error);
    res.status(500).json({ error: 'Mollie API Error', details: error.message });
  }
});

// Setup Webhook to handle successful payments and create subscriptions
app.post('/api/webhook', async (req, res) => {
  try {
    const paymentId = req.body.id;
    if (!paymentId) return res.status(400).send('No id provided');

    // Retrieve payment details from Mollie to verify its status
    const mollieClient = await getMollieClient();
    const payment = await mollieClient.payments.get(paymentId);
    
    // Load config inside webhook to ensure it's not stale
    const config = await getConfig();


    // If this is a successful payment
    console.log(`Webhook triggered for Payment ID: ${paymentId}. Status: ${payment.status}`);

    if (payment.status === 'paid') {
      const alreadyProcessed = await db.isPaymentProcessed(paymentId);
      if (alreadyProcessed) {
        console.log(`Webhook triggered again for already processed Payment ID: ${paymentId}. Skipping actions.`);
        return res.status(200).send('OK');
      }

      // Mark it as processed immediately to prevent concurrent races
      await db.markPaymentProcessed(paymentId);

      console.log('Payment PAID. Processing Won lead...');
      const { yearlyAmount, description, customerName, businessName, website, customerEmail, customerPhone, modulesList, utms, packageId,
              businessAddress, businessPostal, businessCity, businessCountry, kvkNumber } = payment.metadata;
      
      console.log(`Lead Info: ${customerName} | ${businessName} | ${customerEmail}`);

      // Create subscription ONLY if it was a recurring payment
      if (payment.sequenceType === 'first' && payment.customerId && config.molliePaymentType !== 'once') {
        console.log(`First payment successful for Customer ${payment.customerId}. Creating subscription...`);
        
        // Calculate the start date for the next billing cycle (defaulting to 12 months for yearly plans)
        const interval = config.mollieInterval || '12 months';
        let startDate = new Date();
        
        if (interval.includes('months')) {
          const months = parseInt(interval);
          startDate.setMonth(startDate.getMonth() + months);
        } else if (interval.includes('days')) {
          const days = parseInt(interval);
          startDate.setDate(startDate.getDate() + days);
        } else if (interval.includes('weeks')) {
          const weeks = parseInt(interval);
          startDate.setDate(startDate.getDate() + (weeks * 7));
        }

        const startDateStr = startDate.toISOString().split('T')[0];
        console.log(`Subscription interval: ${interval}. First payment paid. Next billing date set to: ${startDateStr}`);

        await mollieClient.customerSubscriptions.create({
          customerId: payment.customerId,
          amount: {
            currency: 'EUR',
            value: yearlyAmount,
          },
          interval: interval,
          startDate: startDateStr, // Start the automated billing after the initial period
          description: `Abonnement verlenging: ${packageId || 'Service'}`,
          metadata: payment.metadata
        });
        console.log(`Subscription created successfully for Customer ${payment.customerId}! Next charge: ${startDateStr}`);
      }

      // ─── FIRE CRM WEBHOOK (SUCCESS) ─────────────────────────────────────
      const crmUrl = config.crmWebhookUrl || process.env.CRM_WEBHOOK_URL;
      if (crmUrl) {
        console.log('Sending lead to CRM webhook:', crmUrl);
        
        const explicitMessage = `Pakket geselecteerd: ${packageId}\nModules geselecteerd: ${modulesList || 'Geen extra modules'}\nAdres: ${businessAddress || ''}\nPostcode: ${businessPostal || ''}\nPlaats: ${businessCity || ''}\nLand: ${businessCountry || ''}\nKVK: ${kvkNumber || ''}`;

        try {
          await fetch(crmUrl, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'User-Agent': 'Kiyoh-Webhook-Client/1.0'
            },
            body: JSON.stringify({
              aanmelding_type: "Kiyoh Online Abonnement",
              bedrijf: businessName || customerName,
              contactpersoon: customerName,
              website: website || '',
              telefoon: customerPhone,
              email: customerEmail,
              collega: "Systeem",
              status: "Won",
              upsell: "NB",
              product: "Kiyoh",
              message: explicitMessage,
              feature: packageId,
              deal_waarde: yearlyAmount,
              kvk: kvkNumber || '',
              adres: businessAddress || '',
              postcode: businessPostal || '',
              plaats: businessCity || '',
              land: businessCountry || '',
              source: utms ? (utms.utm_source || utms.source || 'website') : 'website',
              external_id: paymentId,
              utm: utms || {}
            })
          });
          console.log('CRM webhook sent successfully!');
        } catch (err) {
          console.error('Failed to send CRM webhook:', err);
        }
      }

      // ─── BUILD KIYOH SIGNUP URL FOR CUSTOMER ──────────────────────────
      let signupUrl = null;
      if (!payment.metadata.invoice_id) {
        try {
          const cfg = await getConfig();
          const base = cfg.kiyohSignupUrl || process.env.KIYOH_SIGNUP_URL;
          signupUrl = kiyoh.buildSignupUrl(payment.metadata, base || undefined);
        } catch (err) {
          console.error('Failed to build Kiyoh signup URL:', err.message);
        }
      }

      // ─── SEND INTERNAL NOTIFICATION EMAIL ────────────────────────────
      try {
        await sendInternalNotification(payment.metadata);
        await db.logEmail({ paymentId: payment.id, type: 'internal',
          recipient: (await getConfig()).smtpTo || 'info@klantenvertellen.nl',
          status: 'sent', source: 'webhook' });
      } catch (err) {
        console.error('Failed to send internal notification email:', err.message);
        await db.logEmail({ paymentId: payment.id, type: 'internal',
          status: 'failed', error: err.message, source: 'webhook' });
      }

      // ─── SEND CUSTOMER WELCOME / SETUP EMAIL ─────────────────────────
      if (!payment.metadata.invoice_id) {
        try {
          await sendCustomerWelcome(payment.metadata, signupUrl);
          await db.logEmail({ paymentId: payment.id, type: 'customer',
            recipient: payment.metadata.customerEmail,
            status: 'sent', source: 'webhook' });
        } catch (err) {
          console.error('Failed to send customer welcome email:', err.message);
          await db.logEmail({ paymentId: payment.id, type: 'customer',
            recipient: payment.metadata.customerEmail,
            status: 'failed', error: err.message, source: 'webhook' });
        }
      }

      // ─── SEND OPDRACHT-FORMULIER TO ACCOUNTANT ───────────────────────
      if (!payment.metadata.invoice_id) {
        try {
          const mailer = await getSmtpTransporter();
          if (mailer) {
            await opdracht.sendToAccountant(payment.metadata, true, mailer);
            await db.logEmail({ paymentId: payment.id, type: 'accountant',
              recipient: 'administratie@kv-review.nl',
              status: 'sent', source: 'webhook' });
          } else {
            console.log('SMTP not configured — skipping accountant opdracht-formulier.');
            await db.logEmail({ paymentId: payment.id, type: 'accountant',
              status: 'skipped', error: 'SMTP not configured', source: 'webhook' });
          }
        } catch (err) {
          console.error('Failed to send opdracht-formulier to accountant:', err.message);
          await db.logEmail({ paymentId: payment.id, type: 'accountant',
            recipient: 'administratie@kv-review.nl',
            status: 'failed', error: err.message, source: 'webhook' });
        }
      }

      // ─── FIRE EXACT ONLINE RELATION CREATION (NEW CUSTOMERS) ──────────
      // If invoice_id is empty, it's a new customer paying via the pricing page
      if (!payment.metadata.invoice_id) {
        console.log('New customer detected. Triggering Exact Online Relation creation...');
        try {
          await exact.createRelation(payment.metadata);
          console.log('Exact Online Relation created successfully!');
        } catch (err) {
          console.error('Failed to create Exact Online Relation:', err.message);
          // We don't fail the whole webhook if Exact fails, just log it
        }
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook processing failed:', error);
    res.status(500).send('Internal Server Error');
  }
});

// --- SUBSCRIBER MANAGEMENT API ---
app.get('/api/subscribers', authMiddleware, async (req, res) => {
  try {
    const mollieClient = await getMollieClient();
    
    // 1. Get recent subscriptions
    const subscriptions = await mollieClient.subscription.page({ limit: 50 });
    
    // 2. Fetch customer details for each (to get names)
    // Note: In a production app you'd want to cache or optimize this
    const enrichedSubs = await Promise.all(subscriptions.map(async (sub) => {
      try {
        const customer = await mollieClient.customers.get(sub.customerId);
        return {
          ...sub,
          customerName: customer.name,
          customerEmail: customer.email
        };
      } catch (err) {
        return { ...sub, customerName: 'Onbekende klant', customerEmail: '' };
      }
    }));

    res.json(enrichedSubs);
  } catch (error) {
    console.error('Failed to fetch subscribers:', error);
    res.status(500).json({ error: 'Mollie API Error' });
  }
});

app.post('/api/subscribers/cancel', authMiddleware, async (req, res) => {
  try {
    const { customerId, subscriptionId } = req.body;
    if (!customerId || !subscriptionId) {
      return res.status(400).json({ error: 'Missing customerId or subscriptionId' });
    }

    const mollieClient = await getMollieClient();
    // Correct signature: cancel(subscriptionId, { customerId })
    await mollieClient.customerSubscriptions.cancel(subscriptionId, { customerId });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to cancel subscription:', error);
    res.status(500).json({ error: 'Mollie API Error', details: error.message });
  }
});


// ─── DEALS / ORDER FORMS API ──────────────────────────────────────────────
/**
 * List the most recent paid first-year deals from Mollie with their
 * email-send history pulled from the DB email log.
 */
app.get('/api/deals', authMiddleware, async (req, res) => {
  const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 20, 100));
  try {
    const mollieClient = await getMollieClient();
    const deals = [];
    for await (const p of mollieClient.payments.iterate()) {
      if (p.status !== 'paid') continue;
      if (!p.metadata || p.metadata.invoice_id) continue;
      if (!p.metadata.customerEmail) continue;
      deals.push({
        id: p.id,
        createdAt: p.createdAt,
        amount: p.amount,
        metadata: p.metadata
      });
      if (deals.length >= limit) break;
    }

    const logs = await db.getEmailLogForPayments(deals.map(d => d.id));
    for (const d of deals) {
      const entries = logs[d.id] || [];
      d.emailStatus = {
        internal:   pickLatest(entries, 'internal'),
        customer:   pickLatest(entries, 'customer'),
        accountant: pickLatest(entries, 'accountant')
      };
      d.emailHistory = entries;
    }

    res.json(deals);
  } catch (err) {
    console.error('Failed to fetch deals:', err);
    res.status(500).json({ error: 'Mollie API Error', details: err.message });
  }
});

function pickLatest(entries, type) {
  return entries.find(e => e.email_type === type) || null;
}

/**
 * Single-deal detail.
 */
app.get('/api/deals/:id', authMiddleware, async (req, res) => {
  try {
    const mollieClient = await getMollieClient();
    const p = await mollieClient.payments.get(req.params.id);
    const logs = await db.getEmailLogForPayments([p.id]);
    res.json({
      id: p.id,
      status: p.status,
      createdAt: p.createdAt,
      amount: p.amount,
      method: p.method,
      metadata: p.metadata,
      emailHistory: logs[p.id] || []
    });
  } catch (err) {
    res.status(404).json({ error: 'Payment not found', details: err.message });
  }
});

/**
 * Download the filled opdrachtformulier for a deal as .xlsx.
 */
app.get('/api/deals/:id/opdracht.xlsx', authMiddleware, async (req, res) => {
  try {
    const mollieClient = await getMollieClient();
    const p = await mollieClient.payments.get(req.params.id);
    if (!p.metadata) return res.status(400).send('No metadata on payment');

    const filled = opdracht.fillTemplate(p.metadata, p.status === 'paid');
    const xlsxBuffer = opdracht.buildXlsx(filled);

    const business = (p.metadata.businessName || p.metadata.customerName || 'klant').replace(/[^a-z0-9]+/gi, '_');
    const filename = `Opdrachtformulier - ${business} - ${new Date(p.createdAt).toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xlsxBuffer);
  } catch (err) {
    console.error('Opdracht download error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Resend one or more emails for a given payment.
 * Body: { types: ['internal','customer','accountant'] }   (default = all)
 */
app.post('/api/deals/:id/resend', authMiddleware, async (req, res) => {
  const wanted = (req.body && Array.isArray(req.body.types) && req.body.types.length)
    ? req.body.types
    : ['internal', 'customer', 'accountant'];

  try {
    const mollieClient = await getMollieClient();
    const p = await mollieClient.payments.get(req.params.id);
    if (!p.metadata) return res.status(400).json({ error: 'No metadata on payment' });

    const results = {};

    if (wanted.includes('internal')) {
      try {
        await sendInternalNotification(p.metadata);
        results.internal = { status: 'sent' };
        await db.logEmail({ paymentId: p.id, type: 'internal',
          recipient: (await getConfig()).smtpTo || 'info@klantenvertellen.nl',
          status: 'sent', source: 'manual' });
      } catch (err) {
        results.internal = { status: 'failed', error: err.message };
        await db.logEmail({ paymentId: p.id, type: 'internal',
          status: 'failed', error: err.message, source: 'manual' });
      }
    }

    if (wanted.includes('customer')) {
      try {
        const cfg = await getConfig();
        const base = cfg.kiyohSignupUrl || process.env.KIYOH_SIGNUP_URL;
        const signupUrl = kiyoh.buildSignupUrl(p.metadata, base || undefined);
        await sendCustomerWelcome(p.metadata, signupUrl);
        results.customer = { status: 'sent', recipient: p.metadata.customerEmail };
        await db.logEmail({ paymentId: p.id, type: 'customer',
          recipient: p.metadata.customerEmail, status: 'sent', source: 'manual' });
      } catch (err) {
        results.customer = { status: 'failed', error: err.message };
        await db.logEmail({ paymentId: p.id, type: 'customer',
          recipient: p.metadata.customerEmail, status: 'failed',
          error: err.message, source: 'manual' });
      }
    }

    if (wanted.includes('accountant')) {
      try {
        const mailer = await getSmtpTransporter();
        if (!mailer) throw new Error('SMTP not configured');
        await opdracht.sendToAccountant(p.metadata, p.status === 'paid', mailer);
        results.accountant = { status: 'sent', recipient: 'administratie@kv-review.nl' };
        await db.logEmail({ paymentId: p.id, type: 'accountant',
          recipient: 'administratie@kv-review.nl', status: 'sent', source: 'manual' });
      } catch (err) {
        results.accountant = { status: 'failed', error: err.message };
        await db.logEmail({ paymentId: p.id, type: 'accountant',
          recipient: 'administratie@kv-review.nl', status: 'failed',
          error: err.message, source: 'manual' });
      }
    }

    res.json({ paymentId: p.id, results });
  } catch (err) {
    console.error('Resend error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── EXACT ONLINE TO MOLLIE BRIDGE (v2) ─────────────────────────────
// Landing page for links from Exact Online invoices
app.get('/pay-invoice', async (req, res) => {
  try {
    const { invoice_id, amount, email, package: packageId } = req.query;
    
    if (!invoice_id || !amount || !email) {
      return res.status(400).send('<h1>Foutieve link</h1><p>Ontbrekende gegevens in de link (factuurnummer, bedrag of email).</p>');
    }

    const mollieClient = await getMollieClient();
    
    // 1. Create a Mollie Customer (consistent with the app's standard checkout pattern)
    const customer = await mollieClient.customers.create({
      name: email, 
      email: email
    });


    // 2. Prepare redirect URLs
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const baseUrl = `${protocol}://${req.headers.host}`;

    // 3. Create FIRST payment to capture the mandate
    const payment = await mollieClient.payments.create({
      amount: {
        value: parseFloat(amount).toFixed(2),
        currency: 'EUR'
      },
      customerId: customer.id,
      sequenceType: 'first',
      description: invoice_id, // Reconciliation key for Exact
      redirectUrl: `${baseUrl}/success.html`,
      cancelUrl: `${baseUrl}/cancel.html`,
      webhookUrl: `${baseUrl}/api/webhook`,
      metadata: {
        invoice_id,
        packageId: packageId || 'Pakket',
        yearlyAmount: parseFloat(amount).toFixed(2),
        customerEmail: email,
        customerName: email,
        description: `Factuur ${invoice_id}`
      }
    });

    res.redirect(payment.getCheckoutUrl());
  } catch (error) {
    console.error('Exact Bridge Error:', error);
    res.status(500).send('<h1>Systeemfout</h1><p>Er is een fout opgetreden bij het verwerken van de betaling.</p>');
  }
});

/**
 * Endpoint to generate a QR code image for a specific invoice.
 * Example: /api/qr/invoice?invoice_id=INV123&amount=100.00&email=test@test.com
 */
app.get('/api/qr/invoice', async (req, res) => {
  try {
    const { invoice_id, amount, email } = req.query;
    
    if (!invoice_id || !amount || !email) {
      return res.status(400).send('Invalid parameters');
    }

    // Construct the payment URL (Bridge v2)
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const baseUrl = `${protocol}://${req.headers.host}`;
    const paymentUrl = `${baseUrl}/pay-invoice?invoice_id=${encodeURIComponent(invoice_id)}&amount=${encodeURIComponent(amount)}&email=${encodeURIComponent(email)}`;

    // Generate QR Code as a Buffer
    const qrBuffer = await QRCode.toBuffer(paymentUrl, {
      type: 'png',
      margin: 1,
      width: 300,
      color: {
        dark: '#1a1a1a',
        light: '#ffffff'
      }
    });

    res.setHeader('Content-Type', 'image/png');
    res.send(qrBuffer);
  } catch (err) {
    console.error('QR Gen Error:', err);
    res.status(500).send('Error generating QR code');
  }
});

// ─── SMTP TEST EMAIL ROUTE ───────────────────────────────────────────────────
app.post('/api/admin/test-email', authMiddleware, async (req, res) => {
  try {
    const config = await getConfig();

    const smtpHost = config.smtpHost || process.env.SMTP_HOST;
    const smtpPort = parseInt(config.smtpPort || process.env.SMTP_PORT || '465', 10);
    const smtpUser = config.smtpUser || process.env.SMTP_USER;
    const smtpPass = config.smtpPass || process.env.SMTP_PASS;
    const smtpFrom = config.smtpFrom || smtpUser;
    const smtpTo   = config.smtpTo   || 'info@klantenvertellen.nl';

    if (!smtpHost || !smtpUser || !smtpPass) {
      return res.status(400).json({ error: 'SMTP instellingen zijn niet volledig ingevuld.' });
    }

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: smtpUser, pass: smtpPass }
    });

    await transporter.sendMail({
      from: `"Kiyoh Betalingen" <${smtpFrom}>`,
      to: smtpTo,
      subject: '✅ Test e-mail van Kiyoh betalingssysteem',
      html: `<div style="font-family:Arial,sans-serif;padding:24px;">
        <h2 style="color:#f58220;">E-mail configuratie werkt!</h2>
        <p>Dit is een test e-mail van jouw Kiyoh betalingsportaal.</p>
        <p>Toekomstige succesvolle aankopen worden naar dit adres gestuurd: <strong>${smtpTo}</strong></p>
      </div>`
    });

    res.json({ success: true, message: `Test e-mail verstuurd naar ${smtpTo}` });
  } catch (err) {
    console.error('Test email failed:', err);
    res.status(500).json({ error: 'Versturen mislukt: ' + err.message });
  }
});

/**
 * EXACT ONLINE OAUTH2 ROUTES
 */

app.get('/api/exact/auth', (req, res) => {
  const url = exact.getAuthUrl();
  if (!url) {
    return res.status(500).send('EXACT_CLIENT_ID is not configured in environment variables');
  }
  res.redirect(url);
});

app.get('/api/exact/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code provided');

  try {
    const tokens = await exact.getTokensFromCode(code);
    const config = await loadSettings({});
    config.exactToken = tokens;
    await saveSettings(config);
    res.send('<h1>Exact Online gekoppeld!</h1><p>Je kunt dit venster nu sluiten.</p>');
  } catch (err) {
    console.error('Exact Callback Error:', err.response ? err.response.data : err.message);
    res.status(500).send('Fout bij het koppelen van Exact Online');
  }
});



/**
 * KIYOH SETUP LANDING — kept as a thin redirect to kiyoh.com/signup
 * with the buyer's data prefilled, in case the welcome email link
 * gets stripped or the customer asks for it again.
 */
app.get('/kiyoh-setup', async (req, res) => {
  const cfg = await getConfig();
  const base = cfg.kiyohSignupUrl || process.env.KIYOH_SIGNUP_URL;
  // Pass through any prefilled query params they arrive with.
  const params = new URLSearchParams(req.query);
  const target = base || 'https://kiyoh.com/signup';
  const url = params.toString() ? `${target}?${params.toString()}` : target;
  res.redirect(url);
});

// Start Server
app.listen(port, () => {
  console.log(`Server draait op http://localhost:${port}`);
  console.log('Open your browser and navigate to http://localhost:3000 om de tarieven pagina te zien.');
});

