// Czech UI text layer. Active only for tenant=kiyoh-cz (or lang=cs); other tenants are untouched.
// success/cancel pages are reached via Mollie without the query, so the choice is remembered in localStorage.
(function () {
  var q = new URLSearchParams(location.search), on = false;
  try {
    if (q.get('tenant') === 'kiyoh-cz' || q.get('lang') === 'cs') { on = true; localStorage.setItem('kiyohUiLang', 'cs'); }
    else if (q.get('tenant')) localStorage.removeItem('kiyohUiLang');
    else if (/\/(success|cancel)\.html$/.test(location.pathname)) on = localStorage.getItem('kiyohUiLang') === 'cs';
    else localStorage.removeItem('kiyohUiLang');
  } catch (e) { on = q.get('tenant') === 'kiyoh-cz'; }
  if (!on) return;
  document.documentElement.lang = 'cs';
  var D = {
    'Tarieven | Kiyoh': 'Ceník | Kiyoh', 'Betaling Geslaagd | Kiyoh': 'Platba proběhla | Kiyoh', 'Betaling Geannuleerd | Kiyoh': 'Platba zrušena | Kiyoh',
    'Meest gekozen': 'Nejoblíbenější', 'Jaarlijks gefactureerd:': 'Fakturováno ročně:', '(jaarlijks gefactureerd)': '(fakturováno ročně)',
    'Geselecteerd ✓': 'Vybráno ✓', 'Geselecteerd:': 'Vybráno:', 'Voeg toe': 'Přidat', 'vanaf': 'od', 'Jaarlijks vanaf': 'Ročně od', 'Jaarlijks': 'Ročně',
    '1. Modules': '1. Moduly', '2. Afronden': '2. Dokončení', 'Afronden': 'Dokončení', 'Optimaliseer je': 'Optimalizujte svůj', 'pakket': 'balíček',
    'Voeg optionele modules toe voor extra functionaliteit. Alle prijzen zijn maandelijks, jaarlijks gefactureerd.': 'Přidejte volitelné moduly pro další funkce. Všechny ceny jsou měsíční, fakturované ročně.',
    'De prijs van Productreviews wordt bepaald door de grootte van je pakket.': 'Cena modulu Productreviews závisí na velikosti vašeho balíčku.',
    'Ga naar afronden →': 'Pokračovat k dokončení →', '← Terug naar modules': '← Zpět na moduly', 'Sluiten': 'Zavřít', 'Overzicht': 'Přehled', 'Totaal:': 'Celkem:',
    'Subtotaal': 'Mezisoučet', 'BTW (': 'DPH (', 'Totaal per jaar incl. BTW': 'Celkem za rok vč. DPH', 'Uw Gegevens': 'Vaše údaje',
    'Bedrijfsnaam': 'Název firmy', 'Uw Voornaam & Achternaam': 'Vaše jméno a příjmení', 'E-mailadres': 'E-mailová adresa', 'Telefoonnummer': 'Telefonní číslo',
    'Website URL (bijv. https://...)': 'URL webu (např. https://...)', 'Straat & Huisnummer': 'Ulice a číslo popisné', 'Postcode': 'PSČ', 'Plaats': 'Město',
    'KVK-nummer': 'IČO', 'BTW-nummer (optioneel)': 'DIČ (nepovinné)', 'Start Abonnement 🔒': 'Zahájit předplatné 🔒', 'Bezig…': 'Zpracovává se…',
    'Bezig met omleiden…': 'Přesměrování…', 'Nederland': 'Nizozemsko', 'België': 'Belgie', 'Duitsland': 'Německo', 'Frankrijk': 'Francie', 'Italië': 'Itálie',
    'Oostenrijk': 'Rakousko', 'Spanje': 'Španělsko', 'Tsjechië': 'Česká republika', 'Verenigd Koninkrijk': 'Spojené království', 'Verenigde Staten': 'Spojené státy',
    'Zwitserland': 'Švýcarsko', 'Bedankt voor je bestelling!': 'Děkujeme za vaši objednávku!',
    'Je betaling is succesvol afgerond. We gaan direct voor je aan de slag. Je ontvangt zometeen een bevestiging per e-mail met meer informatie over het opzetten van je account.': 'Vaše platba proběhla úspěšně. Hned se pustíme do práce. Za chvíli vám přijde potvrzení e-mailem s informacemi o nastavení účtu.',
    'Terug naar Home': 'Zpět na úvod', 'Betaling geannuleerd': 'Platba zrušena', 'Terug naar Bestellen': 'Zpět k objednávce',
    'De betaling is geannuleerd of mislukt. Er is niets afgeschreven. Wil je het opnieuw proberen?': 'Platba byla zrušena nebo se nezdařila. Nic jsme vám neúčtovali. Chcete to zkusit znovu?',
    'Vul a.u.b. alle velden in om verder te gaan.': 'Pro pokračování prosím vyplňte všechna pole.',
    'Er ging iets mis bij het genereren van de betaallink.': 'Při vytváření platebního odkazu se něco pokazilo.',
    'Geen extra modules geselecteerd.': 'Nebyly vybrány žádné další moduly.', 'Bezig met omleiden naar de betaling…': 'Přesměrování na platbu…',
    'Kan geen verbinding maken met de server.': 'Nelze se připojit k serveru.'
  };
  var R = [[/^Selecteer (.+)$/, 'Vybrat $1'], [/^(.*) Pakket \(Jaarlijks\)$/, 'Balíček $1 (ročně)'], [/\/mnd\b/g, '/měs.'], [/\/jaar\b/g, '/rok'], [/^vanaf\s*$/, 'od ']];
  function tr(s) {
    var t = s.trim(); if (!t) return s;
    if (D[t]) return s.replace(t, D[t]);
    var o = s; R.forEach(function (r) { o = o.replace(r[0], r[1]); }); return o;
  }
  function walk(n) {
    if (n.nodeType === 3) { var v = tr(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; return; }
    if (n.nodeType !== 1 || /^(SCRIPT|STYLE)$/.test(n.tagName)) return;
    ['placeholder', 'title', 'aria-label', 'alt'].forEach(function (a) { var v = n.getAttribute(a); if (v) { var w = tr(v); if (w !== v) n.setAttribute(a, w); } });
    for (var c = n.firstChild; c; c = c.nextSibling) walk(c);
  }
  var _alert = window.alert; window.alert = function (m) { return _alert.call(window, tr(String(m))); };
  function start() {
    if (document.title) document.title = tr(document.title);
    walk(document.body);
    new MutationObserver(function (ms) { ms.forEach(function (m) {
      if (m.type === 'characterData') walk(m.target); else m.addedNodes.forEach(walk);
    }); }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
