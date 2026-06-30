const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

/**
 * Opdracht-formulier filler + accountant delivery.
 *
 * Loads the master Excel template ("Opdracht formulier.xlsx"), writes
 * only the data cells from Mollie payment metadata, and ships the
 * resulting workbook to administratie@kv-review.nl as an attachment.
 * All styling, merged cells, dropdown lookups (sheet "Data") and
 * formulas stay intact.
 *
 * Cell map below mirrors the actual layout of the "Opdracht" sheet.
 */

const TEMPLATE_PATH = path.join(__dirname, 'Opdracht formulier.xlsx');
const ACCOUNTANT_EMAIL = 'administratie@kv-review.nl';

// Default invitation allowance per package id (matches the pricing config).
const PACKAGE_INVITES = { go: 150, pro: 300, premium: 3000 };

// Map module aliases (lowercased, alphanum only) → the corresponding
// "Prijs inclusief" checkbox label on the opdracht-formulier.
const FEATURE_CHECKBOXES = [
  { cell: 'C39', labels: ['easyclickmodule', 'easyclickreviews', 'easyclick'] },
  { cell: 'E39', labels: ['personalinvitelink', 'easyinvitelink', 'invitelink'] },
  { cell: 'C41', labels: ['productreviews'] },
  { cell: 'E41', labels: ['reviewsplit'] },
  { cell: 'C42', labels: ['xmlfeedintegratie', 'xmlfeed'] },
  { cell: 'E42', labels: ['listings'] },
  { cell: 'C43', labels: ['filterquestion'] },
  { cell: 'E43', labels: ['bcc'] },
  { cell: 'C44', labels: ['widgetcollectie'] },
  { cell: 'E44', labels: ['apiintegratie', 'apiintegration'] }
];

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Excel serial date number for a JS Date (1900 date system, matching
 * what Excel/Google Sheets uses, including the 1900-02-29 bug).
 */
function toExcelDate(d) {
  const epoch = Date.UTC(1899, 11, 30); // 1899-12-30
  return Math.floor((d.getTime() - epoch) / 86400000);
}

/**
 * Split a single street string like "Hoofdstraat 1A" into the parts
 * the address line on the form expects. We keep them joined here since
 * the form has a single "Adres" cell, but expose the split for future use.
 */
function fullAddress(metadata) {
  return metadata.businessAddress || '';
}

/**
 * Set a cell value while preserving its existing style/format.
 */
function setCell(ws, addr, value, type) {
  const existing = ws[addr] || {};
  const cell = { ...existing, v: value, t: type };
  // Drop any cached formatted string so Excel/Sheets re-renders it.
  delete cell.w;
  // For booleans we also wipe formulas defensively.
  if (type === 'b') delete cell.f;
  ws[addr] = cell;
}

function setText(ws, addr, value)   { setCell(ws, addr, String(value || ''), 's'); }
function setNumber(ws, addr, value) { setCell(ws, addr, Number(value) || 0, 'n'); }
function setBool(ws, addr, value)   { setCell(ws, addr, !!value, 'b'); }

/**
 * Build the filled workbook as a Buffer.
 */
function fillXlsx(metadata, paid) {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error(`Template not found: ${TEMPLATE_PATH}`);
  }

  const wb = XLSX.readFile(TEMPLATE_PATH, { cellStyles: true, cellNF: true });
  const ws = wb.Sheets['Opdracht'] || wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('No "Opdracht" sheet in template');

  // ─── Account gegevens ─────────────────────────────────────────────
  setText(ws, 'C4', metadata.businessName || metadata.customerName);
  setText(ws, 'C5', metadata.customerEmail);
  setText(ws, 'C6', metadata.customerEmail);
  setText(ws, 'C7', metadata.website);

  // Bron row: tick "Aanmelding" (C8), leave the rest false.
  setBool(ws, 'C8', true);
  setBool(ws, 'E8', false);
  setBool(ws, 'C9', false);
  setBool(ws, 'E9', false);
  setBool(ws, 'C11', false);
  setBool(ws, 'E11', false);

  // ─── Gebruikers gegevens ──────────────────────────────────────────
  setText(ws, 'C14', fullAddress(metadata));
  setText(ws, 'C15', metadata.businessPostal);
  setText(ws, 'C16', metadata.businessCity);
  setText(ws, 'C17', metadata.customerName);
  setText(ws, 'C18', metadata.customerPhone);
  // C19 = 2e telefoonnummer (niet uitgevraagd in checkout)

  // ─── Factuurgegevens ──────────────────────────────────────────────
  setText(ws, 'C22', metadata.businessName);
  setText(ws, 'C23', metadata.kvkNumber);
  setText(ws, 'C24', metadata.btwNumber);
  setText(ws, 'C25', metadata.customerName);

  const yearly = parseFloat(metadata.yearlyAmount || '0');
  setNumber(ws, 'C26', yearly);
  // F27 = Eenmalige kosten — niet gebruikt
  // C28 / C29 = facturatie tel/email — niet uitgevraagd

  // ─── Pakket ───────────────────────────────────────────────────────
  // Label (C32) is the brand dropdown — this app only sells Kiyoh.
  // Pakket (C33) is the tier prefixed with the brand for clarity on
  // the boekhouder's overview.
  const brand = 'Kiyoh';
  const tier  = metadata.packageId || '';
  setText(ws, 'C32', brand);
  setText(ws, 'C33', tier ? `${brand} ${tier}` : brand);

  const invites = PACKAGE_INVITES[normalize(metadata.packageId)];
  if (invites) setNumber(ws, 'C35', invites);
  setText(ws, 'C36', '12 maanden');

  // ─── Prijs inclusief: tick matching modules ───────────────────────
  const selected = (metadata.modulesList || '')
    .split(',').map(s => normalize(s)).filter(Boolean);
  for (const fc of FEATURE_CHECKBOXES) {
    const on = fc.labels.some(lbl => selected.includes(lbl));
    setBool(ws, fc.cell, on);
  }

  // ─── Toelichting factuur ──────────────────────────────────────────
  setText(ws, 'C45', paid
    ? 'Eerste jaarbedrag betaald via Mollie'
    : 'Nog niet betaald');

  // ─── Product verkocht ─────────────────────────────────────────────
  setNumber(ws, 'C58', toExcelDate(new Date())); // Datum
  setText(ws, 'C59', 'Systeem');                 // Verkoper

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true });
}

/**
 * Main entry point: fill the template, email as attachment.
 */
async function sendToAccountant(metadata, paid, mailer) {
  const xlsxBuffer = fillXlsx(metadata, paid);

  const business = (metadata.businessName || metadata.customerName || 'klant').replace(/[^a-z0-9]+/gi, '_');
  const fileName = `Opdrachtformulier - ${business} - ${new Date().toISOString().slice(0, 10)}.xlsx`;

  const yearly = parseFloat(metadata.yearlyAmount || '0').toFixed(2);
  const modules = metadata.modulesList || 'Geen extra modules';

  const summaryHtml = `
    <div style="font-family:Arial,sans-serif;max-width:600px;">
      <h2 style="color:#f58220;">Nieuw opdrachtformulier</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:6px 0;color:#888;width:160px;">Bedrijf</td><td><strong>${metadata.businessName || metadata.customerName}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#888;">Pakket</td><td>${metadata.packageId || '—'}</td></tr>
        <tr><td style="padding:6px 0;color:#888;">Extra modules</td><td>${modules}</td></tr>
        <tr><td style="padding:6px 0;color:#888;">Jaarbedrag</td><td>€${yearly}</td></tr>
        <tr><td style="padding:6px 0;color:#888;">Betaald</td><td><strong style="color:${paid ? '#68b03d' : '#d9534f'};">${paid ? 'Ja, eerste jaarbedrag voldaan' : 'Nog niet'}</strong></td></tr>
      </table>
      <p style="margin-top:20px;">Het ingevulde opdrachtformulier zit als Excel-bijlage bij deze mail.</p>
      <p style="font-size:12px;color:#aaa;margin-top:24px;">Automatisch verstuurd door het Kiyoh betalingssysteem.</p>
    </div>`;

  await mailer.transporter.sendMail({
    from: mailer.from,
    to: ACCOUNTANT_EMAIL,
    subject: `Opdrachtformulier — ${metadata.businessName || metadata.customerName} (${metadata.packageId})`,
    html: summaryHtml,
    attachments: [{
      filename: fileName,
      content: xlsxBuffer,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    }]
  });

  console.log(`Opdracht-formulier (xlsx) sent to ${ACCOUNTANT_EMAIL}`);
}

module.exports = {
  sendToAccountant,
  fillXlsx
};
