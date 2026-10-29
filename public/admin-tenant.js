// Per-tenant admin layer: tenant switcher + badge, save warning, payment status,
// notifications editor, version history/rollback, copy-from-tenant, tenant logs.
(function () {
  var qs = new URLSearchParams(location.search);
  var TENANT = (qs.get('tenant') || 'kiyoh').toLowerCase();
  var TENANTS = [];
  var dirty = false;
  var EVENTS = { order: 'Nieuwe bestelling', signup: 'Aanmelding (welkomstmail)', dealPaid: 'Deal betaald', cancellation: 'Opzegging' };
  var SECTIONS = { packages: 'Pakketten', modules: 'Modules', coreFeatures: 'Core features', pricing: 'Valuta + BTW', payment: 'Betaalinstellingen', notifications: 'Notificaties', email: 'SMTP', crm: 'CRM-webhook', googleAds: 'Google Ads' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }

  // Admin API calls go to the selected tenant unless the URL already names one.
  function api(url) {
    if (!/[?&]tenant=/.test(url)) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'tenant=' + encodeURIComponent(TENANT);
    return url;
  }
  function info(id) { return TENANTS.filter(function (t) { return t.id === id; })[0] || { id: id, name: id, brandColor: '#888', currency: 'EUR' }; }
  function H() { return { 'Content-Type': 'application/json', 'Authorization': password }; }
  function getJ(url) { return fetch(api(url), { headers: H() }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }); }
  function postJ(url, body) { return fetch(api(url), { method: 'POST', headers: H(), body: JSON.stringify(body || {}) }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); }); }
  function val(id) { var e = $(id); return e ? e.value.trim() : ''; }

  function paintBadge() {
    var t = info(TENANT), b = $('tenant-badge');
    if (b) { b.textContent = t.name + ' · ' + (t.badge || '') + ' · ' + (t.currency || ''); b.style.background = t.brandColor; }
    document.querySelectorAll('.tenant-name-inline').forEach(function (e) { e.textContent = '— ' + t.name; });
    var sel = $('tenant-selector');
    if (sel && TENANTS.length) {
      sel.innerHTML = TENANTS.map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>'; }).join('');
      sel.value = TENANT;
    }
  }

  // ── Fill tenant-only fields from the loaded config ──
  function fillFields() {
    var p = config.payment || {};
    if ($('pay-provider')) $('pay-provider').value = p.provider || 'mollie';
    if ($('pay-live-env')) $('pay-live-env').value = p.liveKeyEnv || '';
    if ($('pay-test-env')) $('pay-test-env').value = p.testKeyEnv || '';
    if ($('pay-mode')) $('pay-mode').value = config.mollieTestMode === false ? 'live' : 'test';
    if ($('tenant-currency')) $('tenant-currency').value = config.currency || '';
    var n = config.notifications || {};
    var ev = n.events || {};
    if ($('notif-cc')) $('notif-cc').value = n.cc !== undefined ? [].concat(n.cc).join(', ') : 'xeno@kiyoh.com';
    if ($('notif-accountant')) $('notif-accountant').value = n.accountant !== undefined ? [].concat(n.accountant).join(', ') : 'administratie@kv-review.nl';
    var box = $('notif-events'); if (!box) return;
    box.innerHTML = Object.keys(EVENTS).map(function (k) {
      var e = ev[k] || {};
      var en = e.enabled !== undefined ? !!e.enabled : k !== 'cancellation';
      var rec = e.recipients !== undefined ? [].concat(e.recipients).join(', ') : (k === 'signup' ? '' : (config.smtpTo || 'info@klantenvertellen.nl'));
      return '<div style="border:1px solid #eee;border-radius:10px;padding:14px;margin-top:14px;" data-ev="' + k + '">' +
        '<h3 style="margin:0 0 8px;font-size:1rem;">' + esc(EVENTS[k]) + ' <label style="font-weight:400;font-size:.85rem;margin-left:10px;"><input type="checkbox" class="ev-en"' + (en ? ' checked' : '') + '> actief</label></h3>' +
        '<div class="field-grid">' +
        '<div class="field full"><label>Ontvangers</label><input type="text" class="ev-rec" value="' + esc(rec) + '"></div>' +
        '<div class="field"><label>Webhook-URL</label><input type="text" class="ev-url" value="' + esc(e.webhookUrl || '') + '"></div>' +
        '<div class="field"><label>Webhook-geheim</label><input type="password" class="ev-secret" value="' + esc(e.webhookSecret || '') + '"></div>' +
        '<div class="field full"><button type="button" class="icon-btn ev-test" style="padding:6px 12px;"><i class="fas fa-paper-plane"></i> Test</button> <span class="ev-res" style="font-size:.8rem;"></span></div>' +
        '</div></div>';
    }).join('');
    box.querySelectorAll('.ev-test').forEach(function (btn) {
      btn.onclick = function () {
        var wrap = btn.closest('[data-ev]'), out = wrap.querySelector('.ev-res');
        if (dirty) { out.textContent = 'Eerst opslaan.'; return; }
        out.textContent = 'Bezig...';
        postJ('/api/admin/notifications/test', { event: wrap.getAttribute('data-ev') })
          .then(function (r) { out.textContent = 'E-mail: ' + r.email + (r.webhook ? ' · webhook: ' + JSON.stringify(r.webhook) : ''); })
          .catch(function (e) { out.textContent = 'Fout: ' + e.message; });
      };
    });
  }

  // ── Write tenant-only fields back into config before saving ──
  function collect() {
    config.payment = Object.assign({}, config.payment || {}, { provider: val('pay-provider') || 'mollie', liveKeyEnv: val('pay-live-env'), testKeyEnv: val('pay-test-env') });
    var cur = val('tenant-currency'); if (cur) config.currency = cur; else delete config.currency;
    var events = {};
    document.querySelectorAll('#notif-events [data-ev]').forEach(function (w) {
      events[w.getAttribute('data-ev')] = {
        enabled: w.querySelector('.ev-en').checked,
        recipients: w.querySelector('.ev-rec').value.trim(),
        webhookUrl: w.querySelector('.ev-url').value.trim(),
        webhookSecret: w.querySelector('.ev-secret').value
      };
    });
    if (Object.keys(events).length) config.notifications = { cc: val('notif-cc'), accountant: val('notif-accountant'), events: events };
  }

  function loadPayment() {
    var box = $('pay-status'); if (!box) return;
    getJ('/api/admin/payment-status').then(function (s) {
      function row(lbl, ok, src) { return '<div>' + lbl + ': <strong style="color:' + (ok ? '#68b03d' : '#d7141a') + '">' + (ok ? 'aanwezig' : 'ontbreekt') + '</strong>' + (src ? ' <span style="color:#888">(' + esc(src) + ')</span>' : '') + '</div>'; }
      box.innerHTML = '<div>Provider: <strong>' + esc(s.provider) + '</strong> · modus: <strong>' + esc(s.mode) + '</strong> · methodes: ' + esc(s.methods) + '</div>' +
        row('Live key', s.liveKeyPresent, s.liveKeySource) + row('Test key', s.testKeyPresent, s.testKeySource) +
        '<div style="margin-top:6px;">Actieve key: <strong style="color:' + (s.activeKeyPresent ? '#68b03d' : '#d7141a') + '">' + (s.activeKeyPresent ? 'OK' : 'ONTBREEKT — betalingen werken niet') + '</strong></div>';
    }).catch(function (e) { box.textContent = 'Status niet beschikbaar: ' + e.message; });
  }

  function loadHistory() {
    var tb = $('history-body'); if (!tb) return;
    fetch('/api/admin/tenants/' + encodeURIComponent(TENANT) + '/history', { headers: H() }).then(function (r) { return r.json(); }).then(function (rows) {
      if (!Array.isArray(rows) || !rows.length) { tb.innerHTML = '<tr><td style="padding:8px;color:#888">Nog geen versies.</td></tr>'; return; }
      tb.innerHTML = rows.map(function (v) {
        return '<tr style="border-bottom:1px solid #eee"><td style="padding:6px">#' + esc(v.id) + '</td><td>' + esc(new Date(v.created_at || v.createdAt).toLocaleString('nl-NL')) + '</td><td>' + esc(v.source || '') + '</td><td>' + esc(v.note || '') + '</td><td><button class="icon-btn" data-rb="' + esc(v.id) + '">Terugzetten</button></td></tr>';
      }).join('');
      tb.querySelectorAll('[data-rb]').forEach(function (b) {
        b.onclick = function () {
          if (!confirm('Versie #' + b.getAttribute('data-rb') + ' terugzetten voor ' + info(TENANT).name + '?')) return;
          fetch('/api/admin/tenants/' + encodeURIComponent(TENANT) + '/rollback', { method: 'POST', headers: H(), body: JSON.stringify({ versionId: b.getAttribute('data-rb') }) })
            .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); location.reload(); }).catch(function (e) { alert('Mislukt: ' + e.message); });
        };
      });
    }).catch(function () { tb.innerHTML = '<tr><td>Laden mislukt.</td></tr>'; });
  }

  function setupCopy() {
    var sel = $('copy-source'), secs = $('copy-sections'), btn = $('copy-btn'); if (!sel) return;
    sel.innerHTML = TENANTS.filter(function (t) { return t.id !== TENANT; }).map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>'; }).join('');
    secs.innerHTML = Object.keys(SECTIONS).map(function (k) { return '<label><input type="checkbox" value="' + k + '"> ' + esc(SECTIONS[k]) + '</label>'; }).join('');
    btn.onclick = function () {
      var chosen = [].slice.call(secs.querySelectorAll('input:checked')).map(function (i) { return i.value; });
      if (!chosen.length) return alert('Kies minstens een onderdeel.');
      if (!confirm('Kopieer ' + chosen.join(', ') + ' van ' + info(sel.value).name + ' naar ' + info(TENANT).name + '? Alleen ' + info(TENANT).name + ' wordt gewijzigd.')) return;
      fetch('/api/admin/tenants/' + encodeURIComponent(TENANT) + '/copy-from', { method: 'POST', headers: H(), body: JSON.stringify({ source: sel.value, sections: chosen }) })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error); location.reload(); }); }).catch(function (e) { alert('Mislukt: ' + e.message); });
    };
  }

  function loadLogs() {
    var tb = $('logs-body'); if (!tb) return;
    getJ('/api/admin/logs?limit=100').then(function (rows) {
      tb.innerHTML = (rows || []).map(function (l) {
        return '<tr style="border-bottom:1px solid #eee"><td style="padding:4px">' + esc(new Date(l.created_at || l.sent_at || l.createdAt).toLocaleString('nl-NL')) + '</td><td>' + esc(l.type) + '</td><td>' + esc(l.recipient) + '</td><td>' + esc(l.status) + '</td><td>' + esc(l.source || '') + '</td></tr>';
      }).join('') || '<tr><td style="color:#888">Geen logs.</td></tr>';
    }).catch(function () { tb.innerHTML = '<tr><td>Laden mislukt.</td></tr>'; });
  }

  // ── Hooks into the existing admin (no behaviour change for other sections) ──
  var origComplete = window.completeLogin;
  if (typeof origComplete === 'function') {
    window.completeLogin = async function () {
      await origComplete.apply(this, arguments);
      paintBadge(); fillFields(); loadPayment();
    };
  }
  var origSave = window.saveConfig;
  if (typeof origSave === 'function') {
    window.saveConfig = async function () {
      if (TENANT !== 'kiyoh' && !confirm('Je slaat op voor ' + info(TENANT).name + ' (' + TENANT + '). Andere tenants blijven ongewijzigd. Doorgaan?')) return;
      collect();
      await origSave.apply(this, arguments);
      dirty = false; loadPayment(); loadHistory();
    };
  }
  var origShow = window.showSection;
  if (typeof origShow === 'function') {
    window.showSection = function (name) {
      var r = origShow.apply(this, arguments);
      if (name === 'payment') loadPayment();
      if (name === 'versions') { setupCopy(); loadHistory(); }
      if (name === 'logs') loadLogs();
      return r;
    };
  }
  document.addEventListener('input', function (e) { if (e.target.closest && e.target.closest('#admin-app')) dirty = true; });
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  fetch('/api/tenants').then(function (r) { return r.json(); }).then(function (list) { TENANTS = list || []; paintBadge(); }).catch(function () {});
})();
