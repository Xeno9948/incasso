const fs = require('fs');
const path = require('path');

/**
 * Opdracht-formulier filler + accountant delivery.
 *
 * Reads the CSV template "Opdracht formulier - Opdracht.csv" in the
 * project root, fills in the values from the Mollie payment metadata,
 * converts to .xlsx (with the same column layout) and emails it to
 * the accountant.
 */

const TEMPLATE_PATH = path.join(__dirname, 'Opdracht formulier - Opdracht.csv');
const ACCOUNTANT_EMAIL = 'administratie@kv-review.nl';

// Module names from the form's "Prijs inclusief" section. We tick these
// when the corresponding module appears in the customer's order.
// Default invitation allowance per package (used to fill the
// "Uitnodigingen per maand" cell on the opdrachtformulier).
const PACKAGE_INVITES = {
  go: 150,
  pro: 300,
  premium: 3000
};

const FEATURE_LABELS = [
  'Easy Click Reviews',
  'Easy Invite Link',
  'Product Reviews',
  'Reviewsplit',
  'XML-feed',
  'Listings',
  'Filter Question',
  'BCC',
  'Widget Collectie',
  'API Integratie'
];

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Parse a CSV line respecting quoted fields with embedded commas/newlines.
 * Returns array of cells. We only need round-tripping, not full RFC 4180.
 */
function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Build a filled CSV string from the template, replacing target cells
 * with values from the payment.
 *
 * The template uses a label-in-column-B / value-in-column-C layout
 * (1-indexed: column 2 → label, column 3 → value). For the feature
 * checkbox rows the layout is:
 *   col 3 = TRUE/FALSE, col 4 = label, col 5 = TRUE/FALSE, col 6 = label
 */
function fillTemplate(metadata, paid) {
  const raw = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const rows = parseCsv(raw);

  const yearly = parseFloat(metadata.yearlyAmount || '0');
  const yearlyStr = `€${yearly.toFixed(2).replace('.', ',')}`;

  const selected = (metadata.modulesList || '')
    .split(',')
    .map(s => normalize(s))
    .filter(Boolean);

  const packageKey = normalize(metadata.packageId);
  const invitesPerMonth = PACKAGE_INVITES[packageKey] || '';

  const fieldMap = {
    'Accountnaam': metadata.businessName || metadata.customerName || '',
    'Gebruikersnaam': metadata.customerEmail || '',
    'E-mailadres voor klanten': metadata.customerEmail || '',
    'Website': metadata.website || '',
    'Adres': metadata.businessAddress || '',
    'Postcode': metadata.businessPostal || '',
    'Verstigingsplaats': metadata.businessCity || '',
    'Naam contactpersoon': metadata.customerName || '',
    'Telefoonnummer voor klanten': metadata.customerPhone || '',
    'Factuur bedrijfsnaam': metadata.businessName || '',
    'KVK': metadata.kvkNumber || '',
    'BTW-nummer': metadata.btwNumber || '',
    'Factuur ter attentie van': metadata.customerName || '',
    'Factuurbedrag (per jaar), let op branche afspraak': yearlyStr,
    'Pakket': metadata.packageId || '',
    'Label': metadata.businessName || metadata.customerName || '',
    'Uitnodigingen per maand': invitesPerMonth ? String(invitesPerMonth) : '',
    'Looptijd': '12 maanden'
  };

  for (const cells of rows) {
    while (cells.length < 7) cells.push('');

    const label = cells[1];

    if (label && fieldMap.hasOwnProperty(label)) {
      cells[2] = fieldMap[label];
    }

    if (label === 'Bron') {
      cells[2] = 'TRUE';
      cells[4] = 'FALSE';
    }

    const leftFeature  = cells[3];
    const rightFeature = cells[5];
    if (FEATURE_LABELS.includes(leftFeature) || FEATURE_LABELS.includes(rightFeature)) {
      if (leftFeature) {
        cells[2] = selected.includes(normalize(leftFeature)) ? 'TRUE' : 'FALSE';
      }
      if (rightFeature) {
        cells[4] = selected.includes(normalize(rightFeature)) ? 'TRUE' : 'FALSE';
      }
    }

    if (label === 'Datum') {
      const d = new Date();
      cells[2] = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
    }

    if (label && label.startsWith('Toelichting factuur')) {
      cells[2] = paid ? 'Eerste jaarbedrag betaald via Mollie' : 'Nog niet betaald';
    }
  }

  return rows.map(r => r.map(csvEscape).join(',')).join('\n');
}

/**
 * Full CSV parser that respects multi-line quoted cells.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\r') { /* skip */ }
      else if (ch === '\n') { row.push(cur); cur = ''; rows.push(row); row = []; }
      else { cur += ch; }
    }
  }
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  return rows;
}

/**
 * Build an .xlsx Buffer from the filled rows so the accountant gets a
 * native Excel file (which also opens cleanly in Google Sheets).
 */
function buildXlsx(filledCsv) {
  const XLSX = require('xlsx');
  const rows = parseCsv(filledCsv);
  const ws = XLSX.utils.aoa_to_sheet(rows);

  // Set sensible column widths so the form is readable.
  ws['!cols'] = [
    { wch: 6 }, { wch: 32 }, { wch: 32 }, { wch: 22 },
    { wch: 22 }, { wch: 22 }, { wch: 12 }
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Opdracht');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Main entry point: fill template, deliver to accountant as Excel.
 *
 * @param {object} metadata - Mollie payment.metadata
 * @param {boolean} paid    - whether the first payment is settled
 * @param {object} mailer   - { transporter, from } pre-built nodemailer
 */
async function sendToAccountant(metadata, paid, mailer) {
  const filled = fillTemplate(metadata, paid);
  const xlsxBuffer = buildXlsx(filled);

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
    </div>
  `;

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
  fillTemplate,
  buildXlsx
};
