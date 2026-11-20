(() => {
  'use strict';

  // ---------- Konfiguracja ----------
  const EU = new Set([
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
    'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  ]);
  const UNKNOWN = '?';
  const BLOCKED = Symbol('blocked');
  const CACHE_TTL_MS = 30 * 24 * 3600 * 1000; // 30 dni
  const UNKNOWN_TTL_MS = 3 * 24 * 3600 * 1000; // brak danych firmy – sprawdzaj częściej
  const CONCURRENCY = 2;
  const DELAY_BETWEEN_MS = 500;
  const BLOCK_PAUSE_MS = 60 * 1000;

  const regionNames = (() => {
    try { return new Intl.DisplayNames(['pl'], { type: 'region' }); } catch { return null; }
  })();
  const countryName = (cc) => {
    if (cc === UNKNOWN) return 'nieznany kraj (brak danych firmy – zapewne osoba prywatna)';
    try { return regionNames?.of(cc) || cc; } catch { return cc; }
  };
  const flag = (cc) =>
    cc === UNKNOWN ? '❔' : String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
  const isEU = (cc) => EU.has(cc);
  const category = (cc) => (cc === UNKNOWN ? 'unknown' : isEU(cc) ? 'eu' : 'noneu');

  // W Firefoksie content.fetch wysyła żądanie dokładnie tak jak strona (te same ciasteczka).
  const pageFetch = (typeof content !== 'undefined' && content.fetch)
    ? (url, opts) => content.fetch(url, opts)
    : (url, opts) => fetch(url, opts);

  // ---------- Stan ----------
  let settings = { hide: false };
  let cache = { o: {}, s: {} }; // o: offerId -> {cc, sid, ts}, s: sellerId -> {cc, ts}
  let offerToSeller = new Map(); // z JSON-a osadzonego w listingu
  let lastUrl = location.href;
  let blockedUntil = 0;

  const fresh = (e) => e && Date.now() - e.ts < (e.cc === UNKNOWN ? UNKNOWN_TTL_MS : CACHE_TTL_MS);

  let saveTimer = null;
  const saveCache = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => browser.storage.local.set({ cache }), 1000);
  };

  // ---------- Parsowanie ----------
  function parseSellerFromHtml(html) {
    const i = html.indexOf('"company":{"name"');
    if (i < 0) return { cc: UNKNOWN, sid: null };
    const chunk = html.slice(i, i + 3000);
    const cc = /"countryCode":"([A-Z]{2})"/.exec(chunk)?.[1] || UNKNOWN;
    const sid = /"verified":(?:true|false|null)\},"id":"(\d+)"/.exec(chunk)?.[1] || null;
    return { cc, sid };
  }

  function buildOfferSellerMap() {
    offerToSeller = new Map();
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent;
      if (!t || !t.includes('"seller":{') || !t.includes('"offerId"')) continue;
      let data;
      try { data = JSON.parse(t); } catch { continue; }
      const stack = [data];
      let guard = 0;
      while (stack.length && guard++ < 200000) {
        const o = stack.pop();
        if (!o || typeof o !== 'object') continue;
        if (o.offerId && o.seller && o.seller.id) offerToSeller.set(String(o.offerId), String(o.seller.id));
        for (const k in o) if (o[k] && typeof o[k] === 'object') stack.push(o[k]);
      }
    }
  }

  function extractOfferId(article) {
    for (const a of article.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href');
      let m = /[?&]offerId=(\d+)/.exec(h);
      if (m) return m[1];
      let decoded = h;
      try { decoded = decodeURIComponent(h); } catch { /* ignore */ }
      m = /[?&]offerId=(\d+)/.exec(decoded) || /\/oferta\/(?:[^?#"]*-)?(\d{6,})(?:[?#]|$)/.exec(decoded);
      if (m) return m[1];
    }
    return null;
  }

  // ---------- Kolejka pobierania ----------
  const queue = [];
  const inflight = new Map(); // klucz -> Promise
  let active = 0;

  function lookup(offerId) {
    const sid = offerToSeller.get(offerId);
    if (sid && fresh(cache.s[sid])) return Promise.resolve(cache.s[sid].cc);
    if (fresh(cache.o[offerId])) {
      const e = cache.o[offerId];
      if (e.sid && fresh(cache.s[e.sid])) return Promise.resolve(cache.s[e.sid].cc);
      return Promise.resolve(e.cc);
    }
    const key = sid ? 's' + sid : 'o' + offerId;
    if (inflight.has(key)) return inflight.get(key);
    const p = new Promise((resolve) => queue.push({ offerId, resolve }));
    inflight.set(key, p);
    p.finally(() => inflight.delete(key));
    pump();
    return p;
  }

  function pump() {
    updatePanel();
    if (Date.now() < blockedUntil) {
      setTimeout(pump, blockedUntil - Date.now() + 50);
      return;
    }
    while (active < CONCURRENCY && queue.length) {
      const job = queue.shift();
      active++;
      fetchOffer(job.offerId)
        .then((cc) => (cc === BLOCKED ? queue.unshift(job) : job.resolve(cc)))
        .catch(() => job.resolve(null))
        .finally(() => {
          active--;
          setTimeout(pump, DELAY_BETWEEN_MS);
        });
    }
  }

  async function fetchOffer(offerId) {
    const res = await pageFetch(`https://allegro.pl/oferta/${offerId}`, { credentials: 'include' });
    const html = await res.text();
    if (res.status === 403 || res.status === 429 || /captcha-delivery\.com/.test(html.slice(0, 5000))) {
      blockedUntil = Date.now() + BLOCK_PAUSE_MS;
      return BLOCKED; // zadanie wraca do kolejki, ponowna próba po przerwie
    }
    if (!res.ok) return null;
    const { cc, sid } = parseSellerFromHtml(html);
    const ts = Date.now();
    cache.o[offerId] = { cc, sid, ts };
    if (sid) cache.s[sid] = { cc, ts };
    saveCache();
    // Inne kafelki tego samego sprzedawcy dostaną wynik bez osobnego pobierania.
    if (sid) setTimeout(scan, 0);
    return cc;
  }

  // ---------- UI listingu ----------
  function itemContainer(article) {
    return article.closest('li') || article;
  }

  function applyResult(article, cc) {
    article.querySelector(':scope > .aks-badge')?.remove();
    article.classList.add('aks-host');
    const badge = document.createElement('span');
    if (!cc) {
      badge.className = 'aks-badge aks-unknown';
      badge.textContent = 'błąd';
      article.prepend(badge);
      return;
    }
    const cat = category(cc);
    article.dataset.aksCat = cat;
    badge.className = `aks-badge aks-${cat}`;
    badge.title = `Sprzedawca: ${countryName(cc)}`;
    const f = document.createElement('span');
    f.className = 'aks-flag';
    f.textContent = flag(cc);
    badge.append(f, document.createTextNode(cc === UNKNOWN ? '?' : cc));
    article.prepend(badge);
    article.classList.toggle('aks-noneu-offer', cat === 'noneu');
    applyHide(article);
  }

  function applyHide(article) {
    const hide = settings.hide && article.dataset.aksCat === 'noneu';
    itemContainer(article).classList.toggle('aks-hidden', hide);
  }

  function scan() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      buildOfferSellerMap();
    }
    if (isOfferPage()) handleOfferPage();

    for (const article of document.querySelectorAll('article')) {
      const offerId = extractOfferId(article);
      if (!offerId) continue;
      if (article.dataset.aksOffer === offerId && article.dataset.aksCat) continue;
      if (article.dataset.aksOffer !== offerId) {
        article.dataset.aksOffer = offerId;
        delete article.dataset.aksCat;
        article.classList.add('aks-host');
        article.querySelector(':scope > .aks-badge')?.remove();
        const loading = document.createElement('span');
        loading.className = 'aks-badge aks-loading';
        loading.textContent = '…';
        article.prepend(loading);
        lookup(offerId).then((cc) => {
          if (article.dataset.aksOffer === offerId) applyResult(article, cc);
          updatePanel();
        });
      }
    }
    updatePanel();
  }

  // ---------- Panel ----------
  let panel = null;
  function ensurePanel() {
    if (panel && document.body.contains(panel)) return panel;
    panel = document.createElement('div');
    panel.id = 'aks-panel';
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = settings.hide;
    cb.addEventListener('change', () => {
      settings.hide = cb.checked;
      browser.storage.local.set({ settings });
      document.querySelectorAll('article[data-aks-cat]').forEach(applyHide);
      updatePanel();
    });
    label.append(cb, document.createTextNode(' Ukryj oferty spoza UE'));
    const stats = document.createElement('div');
    stats.className = 'aks-stats';
    const warn = document.createElement('div');
    warn.className = 'aks-warn';
    panel.append(label, stats, warn);
    document.body.append(panel);
    return panel;
  }

  function updatePanel() {
    const arts = document.querySelectorAll('article[data-aks-offer]');
    if (!arts.length) { panel?.remove(); return; }
    const p = ensurePanel();
    let eu = 0, noneu = 0, unk = 0;
    arts.forEach((a) => {
      const c = a.dataset.aksCat;
      if (c === 'eu') eu++; else if (c === 'noneu') noneu++; else if (c === 'unknown') unk++;
    });
    const pending = queue.length + active;
    p.querySelector('input').checked = settings.hide;
    const setText = (el, txt) => { if (el.textContent !== txt) el.textContent = txt; };
    setText(p.querySelector('.aks-stats'),
      `🇪🇺 UE: ${eu} · 🚩 spoza UE: ${noneu}${settings.hide && noneu ? ' (ukryte)' : ''} · ❔ ${unk}` +
      (pending ? ` · sprawdzam: ${pending}` : ''));
    setText(p.querySelector('.aks-warn'), Date.now() < blockedUntil
      ? 'Allegro ogranicza zapytania – wstrzymano na chwilę.'
      : '');
  }

  // ---------- Strona oferty ----------
  const isOfferPage = () => /^\/(oferta|produkt)\//.test(location.pathname);
  let bannerFor = null;

  function handleOfferPage() {
    const key = location.pathname + location.search;
    if (bannerFor === key && document.getElementById('aks-offer-banner')) return;
    const h1 = document.querySelector('h1');
    if (!h1) return;
    let html = '';
    for (const s of document.querySelectorAll('script')) {
      if (s.textContent.includes('"company":{"name"')) { html = s.textContent; break; }
    }
    if (!html) return;
    bannerFor = key;
    const { cc } = parseSellerFromHtml(html);
    document.getElementById('aks-offer-banner')?.remove();
    const b = document.createElement('div');
    b.id = 'aks-offer-banner';
    const cat = category(cc);
    b.className = `aks-${cat}`;
    b.textContent = cat === 'noneu'
      ? `${flag(cc)} Sprzedawca spoza UE: ${countryName(cc)}`
      : cat === 'eu'
        ? `${flag(cc)} Sprzedawca z UE: ${countryName(cc)}`
        : `❔ Kraj sprzedawcy nieznany`;
    h1.parentElement.insertBefore(b, h1);
  }

  // ---------- Start ----------
  async function init() {
    const stored = await browser.storage.local.get(['settings', 'cache']);
    if (stored.settings) settings = { ...settings, ...stored.settings };
    if (stored.cache) cache = { o: {}, s: {}, ...stored.cache };
    // Sprzątanie przeterminowanych wpisów
    for (const t of ['o', 's']) for (const k in cache[t]) if (!fresh(cache[t][k])) delete cache[t][k];

    buildOfferSellerMap();
    scan();

    let t = null;
    const ours = (n) => n.nodeType === 1
      ? (n.id === 'aks-panel' || n.id === 'aks-offer-banner' || n.classList.contains('aks-badge') || !!n.closest?.('#aks-panel'))
      : !!n.parentElement?.closest('#aks-panel, .aks-badge');
    new MutationObserver((muts) => {
      const relevant = muts.some((m) =>
        !ours(m.target) && ![...m.addedNodes, ...m.removedNodes].every(ours));
      if (!relevant) return;
      clearTimeout(t);
      t = setTimeout(scan, 300);
    }).observe(document.body, { childList: true, subtree: true });

    browser.storage.onChanged.addListener((ch) => {
      if (ch.settings) {
        settings = { ...settings, ...ch.settings.newValue };
        document.querySelectorAll('article[data-aks-cat]').forEach(applyHide);
        updatePanel();
      }
    });
  }

  init();
})();
