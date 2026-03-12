const express = require('express');
const { createMollieClient } = require('@mollie/api-client');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'kiyoh-admin-2024';

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Mollie Client with environment variable
const mollieApiKey = process.env.MOLLIE_API_KEY || 'test_hzHT8sHqADu26Dwmnt36Fu3Wmc5DfD';
const mollieClient = createMollieClient({ apiKey: mollieApiKey });

// Setup Config API Routes
app.get('/api/config', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: 'Could not read config' });
  }
});

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ ok: true });
});

app.post('/api/config', (req, res) => {
  const { password, ...config } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    res.json({ success: true });
  } catch (err) {
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
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
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
        calculatedTotal += m.price;
        descriptionStr += `, Module: ${m.name}`;
      });
    }

    // Advertising is monthly, but billing is yearly
    const yearlyTotal = calculatedTotal * 12;
    const amountStr = yearlyTotal.toFixed(2);

    // 1. Create a Mollie Customer
    const mollieCustomer = await mollieClient.customers.create({
      name: customer.name,
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
        yearlyAmount: amountStr,  // This IS the yearly total (monthly * 12)
        description: descriptionStr,
        customerName: customer.name,
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
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      if (config.crmWebhookUrl) {
        console.log('Sending abandoned cart lead to CRM webhook:', config.crmWebhookUrl);
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
            bedrijf: customer.name,
            contactpersoon: customer.name,
            telefoon: customer.phone || '',
            email: customer.email,
            collega: "Systeem",
            status: "opvolgen",
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
    const payment = await mollieClient.payments.get(paymentId);
    
    // Load config inside webhook to ensure it's not stale
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

    // If this is a successful payment
    if (payment.isPaid()) {
      const { yearlyAmount, description, customerName, customerEmail, customerPhone, modulesList, utms, packageId } = payment.metadata;

      // Create subscription ONLY if it was a recurring payment
      if (payment.sequenceType === 'first' && payment.customerId && config.molliePaymentType !== 'once') {
        console.log(`First payment successful for Customer ${payment.customerId}. Creating subscription...`);
        
        await mollieClient.customers_subscriptions.create({
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
      if (config.crmWebhookUrl) {
        console.log('Sending lead to CRM webhook:', config.crmWebhookUrl);
        
        const explicitMessage = `Pakket geselecteerd: ${packageId}\nModules geselecteerd: ${modulesList || 'Geen extra modules'}`;

        try {
          await fetch(config.crmWebhookUrl, {
            method: 'POST',
            headers: { 
              'Content-Type': 'application/json',
              'User-Agent': 'Kiyoh-Webhook-Client/1.0'
            },
            body: JSON.stringify({
              aanmelding_type: "Kiyoh Online Abonnement",
              bedrijf: customerName,
              contactpersoon: customerName,
              telefoon: customerPhone,
              email: customerEmail,
              collega: "Systeem",
              status: "won",
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
