#!/usr/bin/env node
/**
 * Resend post-payment emails for the last N paid deals.
 *
 * Usage:
 *   node resend-emails.js               # last 4 paid first-year deals
 *   node resend-emails.js --count=6     # custom count
 *   node resend-emails.js --dry-run     # don't actually send, just print
 *   node resend-emails.js tr_xxx tr_yyy # resend specific payment IDs
 *
 * Reads config from the same place the server does (DB → config.json),
 * filters out second-year subscription charges (payments whose metadata
 * has an invoice_id), and resends:
 *   1. internal notification to info@klantenvertellen.nl
 *   2. customer welcome with Kiyoh signup link
 *   3. accountant opdrachtformulier (.xlsx) to administratie@kv-review.nl
 */

const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { createMollieClient } = require('@mollie/api-client');

const db = require('./db');
const kiyoh = require('./kiyoh');
const opdracht = require('./opdracht');

// ─── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const countArg = args.find(a => a.startsWith('--count='));
const COUNT = countArg ? parseInt(countArg.split('=')[1], 10) : 4;
const explicitIds = args.filter(a => a.startsWith('tr_'));

// ─── Config loader (mirrors server.js getConfig) ───────────────────────────
async function getConfig() {
  let fileConfig = {};
  const cfgPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(cfgPath)) {
    try { fileConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
    catch (e) { console.error('Could not parse config.json:', e.message); }
  }
  return await db.loadSettings(fileConfig);
}

// ─── Mailer (mirrors server.js getSmtpTransporter) ─────────────────────────
async function getMailer() {
  const config = await getConfig();
  const smtpHost = config.smtpHost || process.env.SMTP_HOST;
  const smtpPort = parseInt(config.smtpPort || process.env.SMTP_PORT || '465', 10);
  const smtpUser = config.smtpUser || process.env.SMTP_USER;
  const smtpPass = config.smtpPass || process.env.SMTP_PASS;
  const smtpFrom = config.smtpFrom || smtpUser;
  const smtpTo   = config.smtpTo   || 'info@klantenvertellen.nl';

  if (!smtpHost || !smtpUser || !smtpPass) {
    throw new Error('SMTP not configured (smtpHost/smtpUser/smtpPass missing).');
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: smtpUser, pass: smtpPass }
  });

  return { transporter, from: `"Kiyoh Betalingen" <${smtpFrom}>`, to: smtpTo };
}

// ─── Email bodies (kept in sync with server.js) ────────────────────────────
async function sendInternalNotification(mailer, metadata) {
  const { customerName, businessName, website, customerEmail, customerPhone,
          packageId, yearlyAmount, modulesList, description,
          businessAddress, businessPostal, businessCity, businessCountry,
          kvkNumber, btwNumber } = metadata;

  const moduleArr = (modulesList || '').split(',').map(s => s.trim()).filter(Boolean);
  const extraModulesBlock = moduleArr.length ? `
        <div style="margin-top:24px;padding:16px;background:#fff3cd;border:1px solid #ffe69c;border-radius:8px;">
          <strong style="color:#7a5b00;">⚠️ Extra modules nog activeren</strong>
          <p style="margin:8px 0 0;color:#5a4400;font-size:14px;">
            Deze klant heeft extra modules afgenomen die handmatig aangezet moeten worden:
          </p>
          <ul style="margin:8px 0 0;color:#5a4400;font-size:14px;">
            ${moduleArr.map(m => `<li>${m}</li>`).join('')}
          </ul>
        </div>` : '';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#f58220;padding:24px 32px;border-radius:10px 10px 0 0;">
        <h2 style="color:white;margin:0;">✅ Nieuw abonnement afgesloten (resend)</h2>
      </div>
      <div style="background:#fff;border:1px solid #eee;border-top:none;padding:32px;border-radius:0 0 10px 10px;">
        <h3 style="color:#1a1a1a;margin-top:0;">Klantgegevens</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px 0;color:#888;width:180px;">Contactpersoon</td><td>${customerName || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Bedrijfsnaam</td><td>${businessName || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">KVK-nummer</td><td>${kvkNumber || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">BTW-nummer</td><td>${btwNumber || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Adres</td><td>${businessAddress || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Postcode</td><td>${businessPostal || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Plaats</td><td>${businessCity || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Land</td><td>${businessCountry || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">E-mail</td><td><a href="mailto:${customerEmail}">${customerEmail || '—'}</a></td></tr>
          <tr><td style="padding:8px 0;color:#888;">Telefoon</td><td>${customerPhone || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Website</td><td><a href="${website}">${website || '—'}</a></td></tr>
        </table>
        <h3 style="color:#1a1a1a;margin-top:24px;">Pakketgegevens</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px 0;color:#888;width:180px;">Pakket</td><td>${packageId || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Modules</td><td>${modulesList || 'Geen extra modules'}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Jaarbedrag</td><td style="color:#68b03d;">€${yearlyAmount || '—'}</td></tr>
          <tr><td style="padding:8px 0;color:#888;">Omschrijving</td><td>${description || '—'}</td></tr>
        </table>
        ${extraModulesBlock}
        <div style="margin-top:24px;padding:12px;background:#f9f9f9;border-radius:8px;font-size:12px;color:#aaa;">
          Handmatig opnieuw verstuurd via resend-emails.js
        </div>
      </div>
    </div>`;

  await mailer.transporter.sendMail({
    from: mailer.from, to: mailer.to,
    subject: `[Resend] Nieuw abonnement: ${businessName || customerName} — ${packageId}`,
    html
  });
}

async function sendCustomerWelcome(mailer, metadata, signupUrl) {
  if (!metadata.customerEmail) return;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#f58220;padding:24px 32px;border-radius:10px 10px 0 0;">
        <h2 style="color:white;margin:0;">Welkom bij Kiyoh!</h2>
      </div>
      <div style="background:#fff;border:1px solid #eee;border-top:none;padding:32px;border-radius:0 0 10px 10px;font-size:14px;color:#333;">
        <p>Hi ${metadata.customerName || ''},</p>
        <p>Bedankt voor je aanmelding voor het <strong>${metadata.packageId}</strong>-pakket.</p>
        ${signupUrl ? `
          <p>Maak nu in één minuut je account aan — je gegevens staan al voor je klaar:</p>
          <p style="text-align:center;margin:24px 0;">
            <a href="${signupUrl}" style="background:#f58220;color:white;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;display:inline-block;">Account aanmaken</a>
          </p>
          <p style="font-size:12px;color:#888;word-break:break-all;">Of plak deze link in je browser: ${signupUrl}</p>
        ` : ''}
        <p>Vragen? Reageer gewoon op deze mail.</p>
        <p style="margin-top:24px;">— Het Kiyoh team</p>
      </div>
    </div>`;
  await mailer.transporter.sendMail({
    from: mailer.from, to: metadata.customerEmail,
    subject: 'Welkom bij Kiyoh — maak je account aan',
    html
  });
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const config = await getConfig();
  const testMode = config.mollieTestMode !== false;
  const liveKey = process.env.MOLLIE_LIVE_KEY || config.mollieLiveKey;
  const testKey = process.env.MOLLIE_TEST_KEY || config.mollieTestKey;
  const apiKey = testMode ? testKey : liveKey;
  if (!apiKey) throw new Error('No Mollie API key configured.');
  const mollie = createMollieClient({ apiKey });
  console.log(`Mollie mode: ${testMode ? 'TEST' : 'LIVE'}`);

  let payments = [];

  if (explicitIds.length) {
    console.log(`Fetching specified payments: ${explicitIds.join(', ')}`);
    for (const id of explicitIds) {
      try { payments.push(await mollie.payments.get(id)); }
      catch (e) { console.error(`  ${id}: ${e.message}`); }
    }
  } else {
    console.log(`Scanning Mollie for the last ${COUNT} paid first-year deals…`);
    // Iterate from newest. Stop once we collect enough.
    for await (const p of mollie.payments.iterate()) {
      if (p.status !== 'paid') continue;
      if (!p.metadata || p.metadata.invoice_id) continue; // skip renewal invoices
      if (!p.metadata.customerEmail) continue;
      payments.push(p);
      if (payments.length >= COUNT) break;
    }
  }

  if (!payments.length) {
    console.log('No matching payments found.');
    return;
  }

  console.log(`\nFound ${payments.length} payment(s):`);
  for (const p of payments) {
    const m = p.metadata || {};
    console.log(`  • ${p.id}  ${p.createdAt}  ${m.businessName || m.customerName}  €${m.yearlyAmount}  ${m.packageId}`);
  }

  if (dryRun) {
    console.log('\n[dry-run] No emails sent.');
    process.exit(0);
  }

  const mailer = await getMailer();

  let okInternal = 0, okCustomer = 0, okAccountant = 0;
  for (const p of payments) {
    const m = p.metadata;
    const label = `${p.id} (${m.businessName || m.customerName})`;
    console.log(`\n→ ${label}`);

    try {
      await sendInternalNotification(mailer, m);
      console.log('  ✓ internal email sent');
      okInternal++;
    } catch (e) { console.error('  ✗ internal email:', e.message); }

    try {
      const cfg = await getConfig();
      const base = cfg.kiyohSignupUrl || process.env.KIYOH_SIGNUP_URL;
      const signupUrl = kiyoh.buildSignupUrl(m, base || undefined);
      await sendCustomerWelcome(mailer, m, signupUrl);
      console.log(`  ✓ customer welcome sent to ${m.customerEmail}`);
      okCustomer++;
    } catch (e) { console.error('  ✗ customer welcome:', e.message); }

    try {
      await opdracht.sendToAccountant(m, true, mailer);
      console.log('  ✓ accountant opdrachtformulier sent');
      okAccountant++;
    } catch (e) { console.error('  ✗ accountant:', e.message); }
  }

  console.log(`\nDone. internal=${okInternal}/${payments.length}  customer=${okCustomer}/${payments.length}  accountant=${okAccountant}/${payments.length}`);
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
