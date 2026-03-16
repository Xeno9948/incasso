const express = require('express');
const { createMollieClient } = require('@mollie/api-client');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { rateLimit } = require('express-rate-limit');
const { TOTP, NobleCryptoPlugin, ScureBase32Plugin } = require('otplib');
const authenticator = new TOTP({
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin()
});
const QRCode = require('qrcode');

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
app.use(express.json());
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

// Setup Checkout API Route
app.post('/api/checkout', async (req, res) => {
  try {
    const { package, modules, customer, utms } = req.body;

    // Get client IP for UTMs if possible
    const user_ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    if (utms) utms.user_ip = user_ip;

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
      metadata: {
        packageId: package.name,
        yearlyAmount: amountStr,
        description: descriptionStr,
        customerName: customer.pName,
        businessName: customer.bName,
        website: customer.website,
        customerEmail: customer.email,
        customerPhone: customer.phone || '',
        modulesList: modules && modules.length > 0 ? modules.map(m => m.name).join(', ') : '',
        utms: utms || {}
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
        const explicitMessage = `Pakket geselecteerd: ${package.name}\nModules geselecteerd: ${selectedModules}`;

        fetch(config.crmWebhookUrl, {
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

    if (payment.isPaid()) {
      console.log('Payment PAID. Processing Won lead...');
      const { yearlyAmount, description, customerName, businessName, website, customerEmail, customerPhone, modulesList, utms, packageId } = payment.metadata;
      
      console.log(`Lead Info: ${customerName} | ${businessName} | ${customerEmail}`);

      // Create subscription ONLY if it was a recurring payment
      if (payment.sequenceType === 'first' && payment.customerId && config.molliePaymentType !== 'once') {
        console.log(`First payment successful for Customer ${payment.customerId}. Creating subscription...`);
        
        await mollieClient.customerSubscriptions.create({
          customerId: payment.customerId,
          amount: {
            currency: 'EUR',
            value: yearlyAmount,
          },
          interval: config.mollieInterval || '12 months',
          description: payment.description || description,
        });
        console.log(`Subscription created successfully for Customer ${payment.customerId}!`);
      }

      // ─── FIRE CRM WEBHOOK (SUCCESS) ─────────────────────────────────────
      const crmUrl = config.crmWebhookUrl || process.env.CRM_WEBHOOK_URL;
      if (crmUrl) {
        console.log('Sending lead to CRM webhook:', crmUrl);
        
        const explicitMessage = `Pakket geselecteerd: ${packageId}\nModules geselecteerd: ${modulesList || 'Geen extra modules'}`;

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
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook processing failed:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Start Server
app.listen(port, () => {
  console.log(`Server draait op http://localhost:${port}`);
  console.log('Open your browser and navigate to http://localhost:3000 om de tarieven pagina te zien.');
});
