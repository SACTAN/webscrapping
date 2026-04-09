/**
 * HTML Capture Utility — Node.js / Playwright
 * ─────────────────────────────────────────────────────────────────────────────
 * Features:
 *   • Auto-capture on navigation, tab switch, DOM mutation
 *   • Floating "Capture HTML Snippet" button injected into every page
 *   • Active internal-tab detection (aria-selected, CSS classes, panels)
 *   • Deduplication via DOM hash + cooldown
 *   • All files saved to  src/resources/html-pages/PageTitle_TabName.html
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
  outputDir      : path.resolve(__dirname, 'src/resources/html-pages'),
  captureDelay   : 800,     // ms to wait after a trigger before snapping
  cooldown       : 1200,    // ms minimum between captures of same page-identity
  headless       : process.env.HEADLESS === 'true',
  filterDomains  : process.env.DOMAIN ? [process.env.DOMAIN] : [],  // [] = all
  ignorePaths    : ['/favicon', '/ping', '/health'],

  // ── Floating button appearance ──────────────────────────────────────────
  button: {
    label      : '📸 Capture HTML',
    bgColor    : '#4F46E5',          // indigo
    hoverColor : '#3730A3',
    textColor  : '#FFFFFF',
    position   : 'top-right',        // top-right | top-left | bottom-right | bottom-left
  },
};

// ─── Runtime state ────────────────────────────────────────────────────────────
const captureState = new Map();   // pageIdentity → { hash, length, lastCapture }

// ─── Utilities ────────────────────────────────────────────────────────────────
const hash = str =>
  crypto.createHash('md5').update(str).digest('hex').slice(0, 12);

const sanitize = str =>
  (str || 'Unknown')
    .replace(/[^a-zA-Z0-9_\-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60);

const shouldCaptureDomain = url =>
  !CONFIG.filterDomains.length || CONFIG.filterDomains.some(d => url.includes(d));

const shouldIgnorePath = url =>
  CONFIG.ignorePaths.some(p => url.includes(p));

// ─── Active internal-tab detector  (runs in browser context) ─────────────────
const TAB_DETECTOR_SCRIPT = `
(() => {
  // 1. ARIA standard: role="tab" with aria-selected="true"
  const ariaTab = document.querySelector('[role="tab"][aria-selected="true"]');
  if (ariaTab) return (ariaTab.textContent || ariaTab.getAttribute('aria-label') || '').trim();

  // 2. Common CSS active-class patterns
  const patterns = [
    '.tab.active', '.tab.selected', '.tab--active', '.tab--selected',
    '.nav-link.active', '.nav-item.active > a', '.nav-tab.active',
    '[class*="tab"][class*="active"]', '[class*="tab"][class*="selected"]',
    '.is-active[role="tab"]', '.current[role="tab"]',
    'li.active > a', 'button.active[data-tab]',
  ];
  for (const sel of patterns) {
    try {
      const el = document.querySelector(sel);
      if (el) { const t = el.textContent.trim(); if (t) return t; }
    } catch(_) {}
  }

  // 3. Visible tabpanel → its controlling button
  const panels = document.querySelectorAll('[role="tabpanel"]');
  for (const panel of panels) {
    const s = getComputedStyle(panel);
    if (s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0) {
      const ctrl = panel.id
        ? document.querySelector('[aria-controls="' + panel.id + '"]')
        : null;
      if (ctrl) return ctrl.textContent.trim();
    }
  }

  // 4. URL hash fallback
  if (location.hash) return location.hash.replace('#', '');

  return null;
})()
`;

// ─── DOM fingerprint (runs in browser context) ────────────────────────────────
const DOM_FINGERPRINT_SCRIPT = `
(() => {
  const b = document.body;
  if (!b) return { length: 0, visibleText: '' };
  return { length: b.innerHTML.length, visibleText: (b.innerText || '').slice(0, 2000) };
})()
`;

// ─── Floating "Capture HTML Snippet" button ───────────────────────────────────
function buildFloatingButtonScript(cfg) {
  const positions = {
    'top-right'    : 'top:14px;right:14px',
    'top-left'     : 'top:14px;left:14px',
    'bottom-right' : 'bottom:14px;right:14px',
    'bottom-left'  : 'bottom:14px;left:14px',
  };
  const pos = positions[cfg.position] || positions['top-right'];

  return `
  (() => {
    if (document.getElementById('__htmlCaptureBtn')) return;

    // ── Button element ──────────────────────────────────────────────────────
    const btn = document.createElement('button');
    btn.id = '__htmlCaptureBtn';
    btn.innerText = ${JSON.stringify(cfg.label)};
    Object.assign(btn.style, {
      position        : 'fixed',
      ${pos.split(';').map(p => { const [k,v]=p.split(':'); return k+':\''+v+'\''; }).join(',')},
      zIndex          : '2147483647',
      padding         : '8px 14px',
      background      : ${JSON.stringify(cfg.bgColor)},
      color           : ${JSON.stringify(cfg.textColor)},
      border          : 'none',
      borderRadius    : '8px',
      fontSize        : '13px',
      fontFamily      : 'system-ui, sans-serif',
      fontWeight      : '600',
      cursor          : 'pointer',
      boxShadow       : '0 2px 8px rgba(0,0,0,0.25)',
      transition      : 'background 0.15s, transform 0.1s',
      userSelect      : 'none',
      lineHeight      : '1.4',
    });

    // ── Hover ───────────────────────────────────────────────────────────────
    btn.addEventListener('mouseover', () => btn.style.background = ${JSON.stringify(cfg.hoverColor)});
    btn.addEventListener('mouseout',  () => {
      if (!btn._active) btn.style.background = ${JSON.stringify(cfg.bgColor)};
    });

    // ── Click → notify Node.js ──────────────────────────────────────────────
    btn.addEventListener('click', async () => {
      if (btn._active) return;
      btn._active = true;
      const orig = btn.innerText;
      btn.innerText = '⏳ Capturing…';
      btn.style.background = '#6B7280';
      btn.style.transform = 'scale(0.96)';

      try {
        await window.__onManualCapture();
        btn.innerText = '✅ Saved!';
        btn.style.background = '#16A34A';
      } catch(e) {
        btn.innerText = '❌ Error';
        btn.style.background = '#DC2626';
      }

      setTimeout(() => {
        btn.innerText = orig;
        btn.style.background = ${JSON.stringify(cfg.bgColor)};
        btn.style.transform = 'scale(1)';
        btn._active = false;
      }, 1800);
    });

    document.documentElement.appendChild(btn);
  })();
  `;
}

// ─── MutationObserver script (injected into page) ─────────────────────────────
const MUTATION_OBSERVER_SCRIPT = `
  if (!window.__mutObserver) {
    window.__mutObserver = new MutationObserver(mutations => {
      const sig = mutations.some(m =>
        (m.type === 'childList' && m.addedNodes.length > 2) ||
        (m.type === 'attributes' && ['class','aria-selected','aria-hidden','style'].includes(m.attributeName))
      );
      if (sig && window.__onDomChanged) window.__onDomChanged();
    });
    window.__mutObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['class','aria-selected','aria-hidden','style','hidden'],
    });
  }
`;

// ─── Core capture function ────────────────────────────────────────────────────
async function captureIfChanged(page, reason) {
  try {
    const url = page.url();
    if (!url || url === 'about:blank') return;
    if (!shouldCaptureDomain(url) || shouldIgnorePath(url)) return;

    const title    = await page.title().catch(() => 'Unknown');
    const tabName  = await page.evaluate(TAB_DETECTOR_SCRIPT).catch(() => null);
    const { length, visibleText } = await page.evaluate(DOM_FINGERPRINT_SCRIPT)
                                              .catch(() => ({ length: 0, visibleText: '' }));
    const domHash      = hash(visibleText + length);
    const pageIdentity = sanitize(title) + '__' + sanitize(tabName || 'default');
    const now          = Date.now();
    const prev         = captureState.get(pageIdentity);

    if (prev) {
      const unchanged = prev.hash === domHash && prev.length === length;
      const tooSoon   = (now - prev.lastCapture) < CONFIG.cooldown;
      if (unchanged || tooSoon) return;
    }

    // Full outerHTML
    const html = await page.content();

    // Build filename
    const pageTitle = sanitize(title) || 'Page';
    const tabLabel  = sanitize(tabName) || 'Default';
    const fileName  = `${pageTitle}_${tabLabel}.html`;
    const filePath  = path.join(CONFIG.outputDir, fileName);

    const output = `<!-- captured: ${new Date().toISOString()} | reason: ${reason} | url: ${url} -->\n${html}`;
    fs.writeFileSync(filePath, output, 'utf8');

    captureState.set(pageIdentity, { hash: domHash, length, lastCapture: now });
    console.log(`[CAPTURE] ${fileName}  ← ${reason}`);

    return fileName;
  } catch (err) {
    console.error('[CAPTURE ERROR]', err.message);
  }
}

// ─── Per-page setup ───────────────────────────────────────────────────────────
async function setupPage(page) {

  // 1. Expose: DOM mutation debounce
  await page.exposeFunction('__onDomChanged', () => {
    clearTimeout(page._domTimer);
    page._domTimer = setTimeout(() => captureIfChanged(page, 'dom-mutation'), CONFIG.captureDelay);
  }).catch(() => {});

  // 2. Expose: Manual capture button click
  await page.exposeFunction('__onManualCapture', async () => {
    const fileName = await captureIfChanged(page, 'manual-button');
    if (!fileName) {
      // Force-capture even if hash matches (user explicitly requested it)
      const url      = page.url();
      const title    = await page.title().catch(() => 'Unknown');
      const tabName  = await page.evaluate(TAB_DETECTOR_SCRIPT).catch(() => null);
      const html     = await page.content();
      const pageTitle = sanitize(title) || 'Page';
      const tabLabel  = sanitize(tabName) || 'Default';
      const ts        = Date.now();
      const fileName2 = `${pageTitle}_${tabLabel}_${ts}.html`;
      const filePath  = path.join(CONFIG.outputDir, fileName2);
      fs.writeFileSync(filePath, `<!-- manual-force: ${new Date().toISOString()} | url: ${url} -->\n${html}`, 'utf8');
      console.log(`[MANUAL]  ${fileName2}  (forced)`);
    }
  }).catch(() => {});

  // 3. Expose: Tab click debounce
  await page.exposeFunction('__onTabClick', () => {
    clearTimeout(page._tabTimer);
    page._tabTimer = setTimeout(() => captureIfChanged(page, 'tab-click'), CONFIG.captureDelay);
  }).catch(() => {});

  // ── Inject observers + button after every navigation ──────────────────────
  const inject = async () => {
    await page.evaluate(MUTATION_OBSERVER_SCRIPT).catch(() => {});
    await page.evaluate(buildFloatingButtonScript(CONFIG.button)).catch(() => {});
    // Tab-click listener
    await page.evaluate(`
      if (!window.__tabListenerAdded) {
        window.__tabListenerAdded = true;
        document.addEventListener('click', (e) => {
          const el = e.target.closest('[role="tab"],.tab,.nav-link,.nav-tab,[class*="tab"]');
          if (el) window.__onTabClick && window.__onTabClick();
        }, true);
      }
    `).catch(() => {});
  };

  page.on('load', async () => {
    await inject();
    setTimeout(() => captureIfChanged(page, 'page-load'), CONFIG.captureDelay);
  });
  page.on('domcontentloaded', inject);
  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame()) {
      setTimeout(() => captureIfChanged(page, 'navigation'), CONFIG.captureDelay);
    }
  });

  // ── URL polling (SPA pushState / hash changes) ────────────────────────────
  let lastUrl = page.url();
  page._urlPoll = setInterval(async () => {
    const cur = page.url();
    if (cur !== lastUrl) {
      lastUrl = cur;
      setTimeout(() => captureIfChanged(page, 'url-change'), CONFIG.captureDelay);
    }
  }, 500);
}

// ─── Entry point ──────────────────────────────────────────────────────────────
async function startCapture() {
  fs.mkdirSync(CONFIG.outputDir, { recursive: true });

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  HTML Capture Utility  —  Playwright (Node.js)    ');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Output : ${CONFIG.outputDir}`);
  console.log(`  Button : ${CONFIG.button.label}  [${CONFIG.button.position}]`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const browser = await chromium.launch({ headless: CONFIG.headless });
  const context = await browser.newContext();

  // Handle new tabs opened by the app
  context.on('page', async (newPage) => {
    console.log(`[NEW TAB] ${newPage.url()}`);
    await setupPage(newPage);
  });

  const page = await context.newPage();
  await setupPage(page);
  await page.goto('about:blank');

  console.log('[READY]  Browser is open. Navigate to any page.');
  console.log('[READY]  Click the "📸 Capture HTML" button at any time for a manual snapshot.\n');

  // Keep process alive
  await new Promise(() => {});
}

startCapture().catch(console.error);
