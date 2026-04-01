document.addEventListener('DOMContentLoaded', async () => {

  // ─── LOAD CONFIG ─────────────────────────────────────────
  let config = { packages: [], modules: [], coreFeatures: [], googleAdsConversionId: '', googleAdsConversionLabel: '' };
  try {
    const res = await fetch('/api/config');
    config = await res.json();
  } catch (e) {
    console.error('Could not load config:', e);
  }

  // ─── STATE ───────────────────────────────────────────────
  const onlinePackages = config.packages.filter(p => !p.offline);
  const onlineModules = config.modules.filter(m => !m.offline);

  let state = {
    package: onlinePackages[0] ? { name: onlinePackages[0].name, price: onlinePackages[0].price } : { name: '', price: 0 },
    modules: []
  };

  // ─── RENDER PRICING CARDS ─────────────────────────────────
  const pricingGrid = document.getElementById('pricing-grid');
  pricingGrid.innerHTML = '';
  onlinePackages.forEach((pkg, i) => {
    const yearlyTotal = (pkg.price * 12).toLocaleString('nl-NL');
    const card = document.createElement('div');
    card.className = 'pricing-card';
    card.setAttribute('data-package', pkg.id);
    card.setAttribute('data-price', pkg.price);
    card.innerHTML = `
      <div class="pricing-header">
        ${pkg.popular ? '<div class="popular-badge">Meest gekozen</div>' : ''}
        <h3>${pkg.name}</h3>
        <p>${pkg.subtitle}</p>
        <div class="price">€${pkg.price}<span>/mnd</span></div>
        <div class="billing-note" style="font-size:0.85rem;color:#666;margin-top:5px;">
          Jaarlijks gefactureerd: <strong>€${yearlyTotal},- /jaar</strong>
        </div>
      </div>
      <ul class="features-list">
        ${pkg.features.map(f => `<li>${f}</li>`).join('')}
      </ul>
      <button class="btn ${pkg.popular ? 'btn-primary' : 'btn-outline'} package-select-btn">Selecteer ${pkg.name}</button>
    `;
    pricingGrid.appendChild(card);
  });

  // ─── RENDER CORE FEATURES ─────────────────────────────────
  const cfGrid = document.querySelector('.core-features-grid');
  if (cfGrid) {
    cfGrid.innerHTML = '';
    config.coreFeatures.forEach(cf => {
      cfGrid.innerHTML += `
        <div class="cf-item">
          <div class="cf-icon"><i class="${cf.icon}"></i></div>
          <div>
            <strong><a href="${cf.link}" target="_blank" style="color:inherit;text-decoration:none;">${cf.title}</a></strong>
            <p>${cf.description}</p>
          </div>
        </div>`;
    });
  }

  // ─── RENDER MODULES IN MODAL ──────────────────────────────
  const modulesGrid = document.getElementById('modules-grid');

  function renderModulesInModal(packagePrice) {
    modulesGrid.innerHTML = '';
    
    onlineModules.forEach(mod => {
      // Dynamic price for Productreviews: 60% of package price
      let displayPrice = mod.price;
      if (mod.name === 'Productreviews' || mod.id === 'productreviews') {
        displayPrice = packagePrice * 0.6;
      }
      
      const yearly = displayPrice * 12;
      const card = document.createElement('div');
      card.className = 'premium-module-card';
      card.setAttribute('data-module', mod.name);
      card.setAttribute('data-price', displayPrice);
      card.innerHTML = `
        <div class="pm-image"><img src="${mod.image}" alt="${mod.name}"></div>
        <div class="pm-content">
          <h3><a href="${mod.link}" target="_blank" class="feature-link">${mod.name}</a></h3>
          <p>${mod.description}</p>
        </div>
        <div class="pm-price-wrap">
          <span class="pm-price">€${displayPrice.toLocaleString('nl-NL', { minimumFractionDigits: 2 })}<span>/mnd</span></span>
          <div class="pm-yearly">Jaarlijks: €${yearly.toLocaleString('nl-NL', { minimumFractionDigits: 2 })},-</div>
          <div class="pm-select-btn">Voeg toe</div>
        </div>`;
      modulesGrid.appendChild(card);
    });
  }

  // Initial render (will be updated when package is selected)
  renderModulesInModal(state.package.price);

  // ─── ELEMENT REFS ─────────────────────────────────────────
  const modal              = document.getElementById('sales-modal');
  const panelModules       = document.getElementById('modal-panel-modules');
  const panelCheckout      = document.getElementById('modal-panel-checkout');
  const modalCloseBtn      = document.getElementById('modal-close-btn');
  const step2PackageName   = document.getElementById('step2-package-name');
  const modalPackageLabel  = document.getElementById('modal-package-label');
  const modalTotalPreview  = document.getElementById('modal-total-preview');
  const msStep1Dot         = document.getElementById('ms-step-1-dot');
  const msStep2Dot         = document.getElementById('ms-step-2-dot');
  const summaryPackageName = document.getElementById('summary-package-name');
  const summaryPackagePrice= document.getElementById('summary-package-price');
  const summaryModulesList = document.getElementById('summary-modules-list');
  const summaryTotalPrice  = document.getElementById('summary-total-price');
  const btnGoToCheckout    = document.getElementById('btn-go-to-checkout');
  const btnBackToModules   = document.getElementById('btn-back-to-modules');
  const checkoutBtn        = document.getElementById('checkout-btn');

  // ─── MODAL OPEN / CLOSE ───────────────────────────────────
  function openModal() {
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    showModalPanel('modules');
    // Notify parent to maximize iframe
    if (window.self !== window.top) {
      window.parent.postMessage({ type: 'kiyoh-maximize' }, '*');
    }
  }

  function closeModal() {
    modal.classList.remove('open');
    document.body.style.overflow = '';
    // Notify parent to minimize iframe
    if (window.self !== window.top) {
      window.parent.postMessage({ type: 'kiyoh-minimize' }, '*');
    }
  }

  function showModalPanel(panel) {
    if (panel === 'modules') {
      panelModules.classList.add('active');
      panelCheckout.classList.remove('active');
      msStep1Dot.classList.add('active');
      msStep2Dot.classList.remove('active');
    } else {
      panelModules.classList.remove('active');
      panelCheckout.classList.add('active');
      msStep1Dot.classList.remove('active');
      msStep2Dot.classList.add('active');
      buildSummary();
    }
  }

  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  modalCloseBtn.addEventListener('click', closeModal);

  // ─── PACKAGE SELECTION (delegated — cards are dynamic) ───
  pricingGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('.package-select-btn');
    if (!btn) return;
    e.stopPropagation();
    const card = btn.closest('.pricing-card');

    document.querySelectorAll('.pricing-card').forEach(c => {
      c.classList.remove('selected');
      c.querySelector('.package-select-btn').textContent = `Selecteer ${c.querySelector('h3').textContent}`;
    });
    card.classList.add('selected');
    btn.textContent = 'Geselecteerd ✓';

    state.package = {
      name:  card.querySelector('h3').textContent.trim(),
      price: parseFloat(card.getAttribute('data-price'))
    };

    // Reset selected modules state
    state.modules = [];
    
    // Re-render modules in modal with the new package price
    renderModulesInModal(state.package.price);

    step2PackageName.textContent  = state.package.name;
    modalPackageLabel.textContent = state.package.name;
    updateTotalPreview();
    openModal();
  });

  // ─── MODULE SELECTION (delegated) ─────────────────────────
  if (modulesGrid) {
    modulesGrid.addEventListener('click', (e) => {
    if (e.target.tagName.toLowerCase() === 'a') return;
    const card = e.target.closest('.premium-module-card');
    if (!card) return;

    const moduleName  = card.getAttribute('data-module');
    const modulePrice = parseFloat(card.getAttribute('data-price'));
    const selectBtn   = card.querySelector('.pm-select-btn');
    const isSelected  = card.classList.toggle('selected');

    if (isSelected) {
      state.modules.push({ name: moduleName, price: modulePrice });
      selectBtn.textContent = 'Geselecteerd ✓';
    } else {
      state.modules = state.modules.filter(m => m.name !== moduleName);
      selectBtn.textContent = 'Voeg toe';
    }

    updateTotalPreview();
  });
}

  // ─── TOTAL PREVIEW ────────────────────────────────────────
  function updateTotalPreview() {
    let monthlyTotal = state.package.price;
    state.modules.forEach(m => { monthlyTotal += m.price; });
    modalTotalPreview.textContent = `€${monthlyTotal}/mnd`;
  }

  // ─── MODAL NAVIGATION ─────────────────────────────────────
  btnGoToCheckout.addEventListener('click', () => showModalPanel('checkout'));
  btnBackToModules.addEventListener('click', () => showModalPanel('modules'));

  // ─── BUILD CHECKOUT SUMMARY ───────────────────────────────
  function buildSummary() {
    const yearlyPackage = state.package.price * 12;
    summaryPackageName.textContent  = `${state.package.name} Pakket (Jaarlijks)`;
    summaryPackagePrice.textContent = formatEuro(yearlyPackage);

    summaryModulesList.innerHTML = '';
    let yearlyTotal = yearlyPackage;

    if (state.modules.length === 0) {
      summaryModulesList.innerHTML = '<div style="font-style:italic;color:#aaa;font-size:0.85rem;margin-bottom:8px;">Geen extra modules geselecteerd.</div>';
    } else {
      state.modules.forEach(m => {
        const moduleYearly = m.price * 12;
        yearlyTotal += moduleYearly;
        const row = document.createElement('div');
        row.className = 'summary-row';
        row.innerHTML = `<span>+ ${m.name}</span><span>${formatEuro(moduleYearly)}</span>`;
        summaryModulesList.appendChild(row);
      });
    }

    summaryTotalPrice.textContent = formatEuro(yearlyTotal);
  }

  function formatEuro(amount) {
    return `€${amount.toLocaleString('nl-NL', { minimumFractionDigits: 2 })}`;
  }

  // ─── CHECKOUT ─────────────────────────────────────────────
  checkoutBtn.addEventListener('click', async () => {
    const pName    = document.getElementById('customer-personal-name').value.trim();
    const bName    = document.getElementById('customer-business-name').value.trim();
    const website  = document.getElementById('customer-website').value.trim();
    const email    = document.getElementById('customer-email').value.trim();
    const phone    = document.getElementById('customer-phone').value.trim();

    if (!pName || !bName || !website || !email || !phone) {
      alert('Vul a.u.b. alle velden in om verder te gaan.');
      return;
    }

    checkoutBtn.textContent = 'Bezig…';
    checkoutBtn.disabled = true;

    // Collect UTM Parameters
    const params = new URLSearchParams(window.location.search);
    const utms = {
      utm_source: params.get('utm_source') || '',
      gclid: params.get('gclid') || '',
      gbraid: params.get('gbraid') || '',
      fbclid: params.get('fbclid') || '',
      li_fat_id: params.get('li_fat_id') || '',
      ga4id: params.get('ga4id') || '',
      user_agent: navigator.userAgent || ''
      // IP will be handled server-side
    };

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...state, customer: { pName, bName, website, email, phone }, utms })
      });

      if (!res.ok) throw new Error('Server error');
      const data = await res.json();

      if (data.checkoutUrl) {
        // If in iframe, request parent to handle checkout redirect
        if (window.self !== window.top) {
          window.parent.postMessage({ type: 'kiyoh-checkout', checkoutUrl: data.checkoutUrl }, '*');
          checkoutBtn.textContent = 'Bezig met omleiden…';
        } else {
          window.location.href = data.checkoutUrl;
        }
      } else {
        alert('Er ging iets mis bij het genereren van de betaallink.');
        checkoutBtn.textContent = 'Start Abonnement 🔒';
        checkoutBtn.disabled = false;
      }
    } catch (err) {
      console.error('Checkout error:', err);
      alert('Kan geen verbinding maken met de server.');
      checkoutBtn.textContent = 'Start Abonnement 🔒';
      checkoutBtn.disabled = false;
    }
  });

  updateTotalPreview();
});
