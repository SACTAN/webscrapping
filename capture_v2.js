/**
 * capture.js  — HTML + Element DNA Capture Utility
 * ─────────────────────────────────────────────────────────────────────────────
 * Every capture now produces THREE files:
 *   Dashboard_Overview.html              ← full page HTML
 *   Dashboard_Overview_locators.csv      ← PageName, LocatorName, LocatorType, LocatorValue
 *   Dashboard_Overview_dna.json          ← full element DNA (XPath, CSS, attrs, parent, siblings, children)
 *
 * Floating "📸 Capture HTML" button injected on every page.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { chromium }        = require('playwright');
const fs                  = require('fs');
const path                = require('path');
const crypto              = require('crypto');
const { extractAndSave }  = require('./elementExtractor');

// ─── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
  outputDir     : path.resolve(__dirname, 'resources/html-pages'),
  captureDelay  : 800,
  cooldown      : 1200,
  headless      : process.env.HEADLESS === 'true',
  filterDomains : process.env.DOMAIN ? [process.env.DOMAIN] : [],
  ignorePaths   : ['/favicon', '/ping', '/health'],

  button: {
    label      : '📸 Capture HTML + DNA',
    bgColor    : '#4F46E5',
    hoverColor : '#3730A3',
    textColor  : '#FFFFFF',
    position   : 'top-right',
  },

  // Set false to skip DNA extraction (faster, HTML only)
  extractDNA    : true,
};

// ─── State ────────────────────────────────────────────────────────────────────
const captureState = new Map();

// ─── Utilities ────────────────────────────────────────────────────────────────
const hash      = str => crypto.createHash('md5').update(str).digest('hex').slice(0, 12);
const sanitize  = str => (str || 'Unknown')
  .replace(/[^a-zA-Z0-9_\-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60);
const shouldCaptureDomain = url =>
  !CONFIG.filterDomains.length || CONFIG.filterDomains.some(d => url.includes(d));
const shouldIgnorePath = url =>
  CONFIG.ignorePaths.some(p => url.includes(p));

// ─── Tab detector ─────────────────────────────────────────────────────────────
const TAB_DETECTOR_SCRIPT = `
(() => {
  const ariaTab = document.querySelector('[role="tab"][aria-selected="true"]');
  if (ariaTab) return (ariaTab.textContent || ariaTab.getAttribute('aria-label') || '').trim();
  const patterns = ['.tab.active','.tab.selected','.tab--active','.tab--selected',
    '.nav-link.active','.nav-item.active > a','.nav-tab.active',
    '[class*="tab"][class*="active"]','[class*="tab"][class*="selected"]',
    '.is-active[role="tab"]','.current[role="tab"]','li.active > a','button.active[data-tab]'];
  for (const sel of patterns) {
    try { const el=document.querySelector(sel); if(el){const t=el.textContent.trim(); if(t) return t;} } catch(_){}
  }
  const panels = document.querySelectorAll('[role="tabpanel"]');
  for (const p of panels) {
    const s=getComputedStyle(p);
    if(s.display!=='none'&&s.visibility!=='hidden'&&parseFloat(s.opacity)>0){
      const ctrl=p.id?document.querySelector('[aria-controls="'+p.id+'"]'):null;
      if(ctrl) return ctrl.textContent.trim();
    }
  }
  if(location.hash) return location.hash.replace('#','');
  return null;
})()
`;

const DOM_FINGERPRINT_SCRIPT = `
(() => {
  const b=document.body; if(!b) return {length:0,visibleText:''};
  return {length:b.innerHTML.length, visibleText:(b.innerText||'').slice(0,2000)};
})()
`;

const MUTATION_OBSERVER_SCRIPT = `
if (!window.__mutObserver) {
  window.__mutObserver = new MutationObserver(ms => {
    const sig=ms.some(m=>(m.type==='childList'&&m.addedNodes.length>2)||
      (m.type==='attributes'&&['class','aria-selected','aria-hidden','style'].includes(m.attributeName)));
    if(sig&&window.__onDomChanged) window.__onDomChanged();
  });
  window.__mutObserver.observe(document.body,{
    childList:true,subtree:true,attributes:true,
    attributeFilter:['class','aria-selected','aria-hidden','style','hidden']
  });
}
`;

function buildButtonScript(cfg) {
  const posMap = {
    'top-right'   :'top:14px;right:14px',
    'top-left'    :'top:14px;left:14px',
    'bottom-right':'bottom:14px;right:14px',
    'bottom-left' :'bottom:14px;left:14px',
  };
  const pos = posMap[cfg.position] || posMap['top-right'];
  return `
  (() => {
    if (document.getElementById('__htmlCaptureBtn')) return;
    const btn = document.createElement('button');
    btn.id = '__htmlCaptureBtn';
    btn.innerText = ${JSON.stringify(cfg.label)};
    Object.assign(btn.style, {
      position:'fixed',${pos.split(';').map(p=>{const[k,v]=p.split(':');return k+':\''+v+'\''}).join(',')},
      zIndex:'2147483647',padding:'8px 14px',background:${JSON.stringify(cfg.bgColor)},
      color:${JSON.stringify(cfg.textColor)},border:'none',borderRadius:'8px',fontSize:'13px',
      fontFamily:'system-ui,sans-serif',fontWeight:'600',cursor:'pointer',
      boxShadow:'0 2px 8px rgba(0,0,0,0.25)',transition:'background 0.15s,transform 0.1s',userSelect:'none',
    });
    btn.addEventListener('mouseover', ()=> btn.style.background=${JSON.stringify(cfg.hoverColor)});
    btn.addEventListener('mouseout',  ()=>{ if(!btn._active) btn.style.background=${JSON.stringify(cfg.bgColor)}; });
    btn.addEventListener('click', async ()=>{
      if(btn._active) return; btn._active=true;
      const orig=btn.innerText;
      btn.innerText='⏳ Capturing…'; btn.style.background='#6B7280'; btn.style.transform='scale(0.96)';
      try {
        await window.__onManualCapture();
        btn.innerText='✅ Saved!'; btn.style.background='#16A34A';
      } catch(e) {
        btn.innerText='❌ Error'; btn.style.background='#DC2626';
      }
      setTimeout(()=>{btn.innerText=orig;btn.style.background=${JSON.stringify(cfg.bgColor)};
        btn.style.transform='scale(1)';btn._active=false;},1800);
    });
    document.documentElement.appendChild(btn);
  })();`;
}

// ─── Core capture ─────────────────────────────────────────────────────────────
async function captureIfChanged(page, reason) {
  try {
    const url = page.url();
    if (!url || url === 'about:blank') return;
    if (!shouldCaptureDomain(url) || shouldIgnorePath(url)) return;

    const title   = await page.title().catch(() => 'Unknown');
    const tabName = await page.evaluate(TAB_DETECTOR_SCRIPT).catch(() => null);
    const { length, visibleText } = await page.evaluate(DOM_FINGERPRINT_SCRIPT)
                                              .catch(() => ({ length: 0, visibleText: '' }));
    const domHash      = hash(visibleText + length);
    const pageIdentity = sanitize(title) + '__' + sanitize(tabName || 'default');
    const now          = Date.now();
    const prev         = captureState.get(pageIdentity);

    if (prev) {
      if (prev.hash === domHash && prev.length === length) return;
      if ((now - prev.lastCapture) < CONFIG.cooldown) return;
    }

    const pageTitle = sanitize(title) || 'Page';
    const tabLabel  = sanitize(tabName) || 'Default';
    const pageName  = `${pageTitle}_${tabLabel}`;

    // ── 1. Save HTML ──────────────────────────────────────────────────────
    const html     = await page.content();
    const htmlPath = path.join(CONFIG.outputDir, `${pageName}.html`);
    fs.writeFileSync(htmlPath, `<!-- captured: ${new Date().toISOString()} | reason: ${reason} | url: ${url} -->\n${html}`, 'utf8');
    console.log(`[HTML]   ${pageName}.html  ← ${reason}`);

    // ── 2. Extract element DNA → CSV + JSON ──────────────────────────────
    if (CONFIG.extractDNA) {
      await extractAndSave(page, pageName, CONFIG.outputDir);
    }

    captureState.set(pageIdentity, { hash: domHash, length, lastCapture: now });
    return pageName;

  } catch (err) {
    console.error('[CAPTURE ERROR]', err.message);
  }
}

// Force-capture (manual button — bypasses dedup)
async function forceCapture(page, reason) {
  try {
    const url      = page.url();
    const title    = await page.title().catch(() => 'Unknown');
    const tabName  = await page.evaluate(TAB_DETECTOR_SCRIPT).catch(() => null);
    const pageTitle = sanitize(title) || 'Page';
    const tabLabel  = sanitize(tabName) || 'Default';
    const ts        = Date.now();
    const pageName  = `${pageTitle}_${tabLabel}_${ts}`;

    const html     = await page.content();
    const htmlPath = path.join(CONFIG.outputDir, `${pageName}.html`);
    fs.writeFileSync(htmlPath, `<!-- manual: ${new Date().toISOString()} | url: ${url} -->\n${html}`, 'utf8');
    console.log(`[MANUAL] ${pageName}.html`);

    if (CONFIG.extractDNA) {
      await extractAndSave(page, pageName, CONFIG.outputDir);
    }
  } catch (err) {
    console.error('[MANUAL ERROR]', err.message);
  }
}

// ─── Per-page setup ───────────────────────────────────────────────────────────
async function setupPage(page) {
  await page.exposeFunction('__onDomChanged', () => {
    clearTimeout(page._domTimer);
    page._domTimer = setTimeout(() => captureIfChanged(page, 'dom-mutation'), CONFIG.captureDelay);
  }).catch(() => {});

  await page.exposeFunction('__onManualCapture', () => forceCapture(page, 'manual')).catch(() => {});

  await page.exposeFunction('__onTabClick', () => {
    clearTimeout(page._tabTimer);
    page._tabTimer = setTimeout(() => captureIfChanged(page, 'tab-click'), CONFIG.captureDelay);
  }).catch(() => {});

  const inject = async () => {
    await page.evaluate(MUTATION_OBSERVER_SCRIPT).catch(() => {});
    await page.evaluate(buildButtonScript(CONFIG.button)).catch(() => {});
    await page.evaluate(`
      if (!window.__tabListenerAdded) {
        window.__tabListenerAdded = true;
        document.addEventListener('click', e => {
          const el=e.target.closest('[role="tab"],.tab,.nav-link,.nav-tab,[class*="tab"]');
          if(el&&window.__onTabClick) window.__onTabClick();
        }, true);
      }
    `).catch(() => {});
  };

  page.on('load', async () => {
    await inject();
    setTimeout(() => captureIfChanged(page, 'page-load'), CONFIG.captureDelay);
  });
  page.on('domcontentloaded', inject);
  page.on('framenavigated', async frame => {
    if (frame === page.mainFrame())
      setTimeout(() => captureIfChanged(page, 'navigation'), CONFIG.captureDelay);
  });

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

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  HTML + Element DNA Capture Utility  —  Playwright   ');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Output : ${CONFIG.outputDir}`);
  console.log(`  DNA    : ${CONFIG.extractDNA ? 'ON (CSV + JSON per page)' : 'OFF'}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const browser = await chromium.launch({ headless: CONFIG.headless });
  const context = await browser.newContext();
  context.on('page', async p => { console.log(`[NEW TAB] ${p.url()}`); await setupPage(p); });

  const page = await context.newPage();
  await setupPage(page);
  await page.goto('about:blank');

  console.log('[READY]  Browser open. Navigate to any page.');
  console.log('[READY]  Click "📸 Capture HTML + DNA" for a manual snapshot.\n');
  await new Promise(() => {});
}

startCapture().catch(console.error);
