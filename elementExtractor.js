/**
 * elementExtractor.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Extracts complete "DNA" of every interactive element on a page.
 * For each element produces:
 *   - Meaningful locator name  (e.g. Login_Button, Patient_Name_Input)
 *   - Best CSS selector        (unique, shortest possible)
 *   - Relative XPath           (human-readable preferred)
 *   - Absolute XPath           (full path fallback)
 *   - All HTML attributes
 *   - Parent reference         (tag, id, classes)
 *   - Previous + next sibling  (tag, id, text)
 *   - Direct children summary
 *   - Computed role, visibility, dimensions
 *
 * Outputs:
 *   PageTitle_TabName_locators.csv   — 4 columns: PageName,LocatorName,LocatorType,LocatorValue
 *   PageTitle_TabName_dna.json       — full element DNA for every interactive element
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

// ─── The big script that runs inside the browser ──────────────────────────────
// Returns an array of element DNA objects.
const ELEMENT_DNA_SCRIPT = `
(() => {

  // ── Helpers ────────────────────────────────────────────────────────────────

  function sanitizeName(str) {
    return (str || '')
      .replace(/[\\r\\n\\t]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim()
      .slice(0, 60);
  }

  function toPascalWords(str) {
    return (str || '')
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join('_');
  }

  function isVisible(el) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // ── Locator name generation ────────────────────────────────────────────────
  // Priority: aria-label > placeholder > name > id > text > title > type
  function getLocatorName(el) {
    const tag  = el.tagName.toLowerCase();
    const type = el.getAttribute('type') || '';

    // Determine role suffix
    let role = 'Element';
    if (tag === 'button' || type === 'button' || type === 'submit' || type === 'reset') role = 'Button';
    else if (tag === 'a') role = 'Link';
    else if (tag === 'input') {
      if (type === 'text' || type === 'search' || type === 'email' || type === 'tel' || type === 'url' || type === 'password' || type === '') role = 'Input';
      else if (type === 'checkbox') role = 'Checkbox';
      else if (type === 'radio')    role = 'RadioButton';
      else if (type === 'file')     role = 'FileUpload';
      else if (type === 'number')   role = 'NumberInput';
      else if (type === 'date' || type === 'datetime-local') role = 'DatePicker';
      else if (type === 'submit')   role = 'SubmitButton';
      else if (type === 'reset')    role = 'ResetButton';
      else role = 'Input';
    }
    else if (tag === 'textarea')  role = 'TextArea';
    else if (tag === 'select')    role = 'Dropdown';
    else if (tag === 'img')       role = 'Image';
    else if (tag === 'form')      role = 'Form';
    else if (tag === 'table')     role = 'Table';
    else if (tag === 'nav')       role = 'Navigation';
    else if (['h1','h2','h3','h4','h5','h6'].includes(tag)) role = 'Heading';

    // Name candidates in priority order
    const candidates = [
      el.getAttribute('aria-label'),
      el.getAttribute('placeholder'),
      el.getAttribute('name'),
      el.getAttribute('id'),
      sanitizeName(el.textContent),
      el.getAttribute('title'),
      el.getAttribute('value'),
      el.getAttribute('alt'),
      el.getAttribute('data-testid'),
      el.getAttribute('data-cy'),
      el.getAttribute('data-qa'),
    ].filter(v => v && v.trim().length > 0 && v.trim().length < 60);

    const label = candidates[0]
      ? toPascalWords(candidates[0])
      : (el.getAttribute('class') || '').split(' ').filter(Boolean).map(toPascalWords)[0] || tag.toUpperCase();

    return label + '_' + role;
  }

  // ── CSS selector generation ────────────────────────────────────────────────
  function getCssSelector(el) {
    // 1. Unique ID
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1)
      return '#' + CSS.escape(el.id);

    // 2. Unique [data-testid], [data-cy], [data-qa]
    for (const attr of ['data-testid','data-cy','data-qa','data-id','data-name']) {
      const val = el.getAttribute(attr);
      if (val) {
        const sel = '[' + attr + '="' + val + '"]';
        if (document.querySelectorAll(sel).length === 1) return sel;
      }
    }

    // 3. Tag + name attribute (forms)
    const name = el.getAttribute('name');
    if (name) {
      const sel = el.tagName.toLowerCase() + '[name="' + name + '"]';
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // 4. Tag + aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      const sel = el.tagName.toLowerCase() + '[aria-label="' + ariaLabel.replace(/"/g, '\\\\"') + '"]';
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // 5. Tag + placeholder
    const ph = el.getAttribute('placeholder');
    if (ph) {
      const sel = el.tagName.toLowerCase() + '[placeholder="' + ph.replace(/"/g, '\\\\"') + '"]';
      if (document.querySelectorAll(sel).length === 1) return sel;
    }

    // 6. Build path walking up DOM
    function pathStep(node) {
      let step = node.tagName.toLowerCase();
      if (node.id) return '#' + CSS.escape(node.id);
      const classes = Array.from(node.classList).slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
      if (classes) step += classes;
      // Add :nth-child if siblings of same type exist
      const siblings = node.parentElement
        ? Array.from(node.parentElement.children).filter(s => s.tagName === node.tagName)
        : [];
      if (siblings.length > 1) {
        const idx = siblings.indexOf(node) + 1;
        step += ':nth-of-type(' + idx + ')';
      }
      return step;
    }

    const steps = [];
    let cur = el;
    while (cur && cur !== document.body && steps.length < 5) {
      steps.unshift(pathStep(cur));
      if (cur.id) break;  // ID is unique, stop walking
      cur = cur.parentElement;
    }
    return steps.join(' > ');
  }

  // ── XPath generation ───────────────────────────────────────────────────────

  function getRelativeXPath(el) {
    const tag   = el.tagName.toLowerCase();
    const id    = el.getAttribute('id');
    const name  = el.getAttribute('name');
    const text  = sanitizeName(el.textContent).slice(0, 40);
    const ph    = el.getAttribute('placeholder');
    const aria  = el.getAttribute('aria-label');
    const type  = el.getAttribute('type');
    const title = el.getAttribute('title');
    const dtid  = el.getAttribute('data-testid');

    // Most specific first
    if (id)    return '//' + tag + '[@id="' + id + '"]';
    if (dtid)  return '//' + tag + '[@data-testid="' + dtid + '"]';
    if (aria)  return '//' + tag + '[@aria-label="' + aria + '"]';
    if (name)  return '//' + tag + '[@name="' + name + '"]';
    if (ph)    return '//' + tag + '[@placeholder="' + ph + '"]';
    if (title) return '//' + tag + '[@title="' + title + '"]';

    // Button/link by text
    if ((tag === 'button' || tag === 'a') && text && text.length < 40)
      return '//' + tag + '[normalize-space()="' + text + '"]';

    // Input by type
    if (tag === 'input' && type)
      return '//' + tag + '[@type="' + type + '"]';

    // Class-based fallback
    const cls = Array.from(el.classList).slice(0, 2).join(' ');
    if (cls) return '//' + tag + '[contains(@class,"' + cls.split(' ')[0] + '")]';

    return getAbsoluteXPath(el);
  }

  function getAbsoluteXPath(el) {
    if (el === document.body) return '/html/body';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let index = 1;
      let sib = node.previousSibling;
      while (sib) {
        if (sib.nodeType === 1 && sib.tagName === node.tagName) index++;
        sib = sib.previousSibling;
      }
      const total = node.parentNode
        ? Array.from(node.parentNode.childNodes)
            .filter(n => n.nodeType === 1 && n.tagName === node.tagName).length
        : 1;
      const part = node.tagName.toLowerCase() + (total > 1 ? '[' + index + ']' : '');
      parts.unshift(part);
      node = node.parentNode;
      if (node === document.documentElement) { parts.unshift('html'); break; }
    }
    return '/' + parts.join('/');
  }

  // ── Attribute snapshot ─────────────────────────────────────────────────────
  function getAllAttributes(el) {
    const attrs = {};
    for (const attr of el.attributes) attrs[attr.name] = attr.value;
    return attrs;
  }

  // ── Parent info ────────────────────────────────────────────────────────────
  function getParentInfo(el) {
    const p = el.parentElement;
    if (!p) return null;
    return {
      tag     : p.tagName.toLowerCase(),
      id      : p.id || null,
      classes : Array.from(p.classList),
      xpath   : getRelativeXPath(p),
      css     : getCssSelector(p),
    };
  }

  // ── Sibling info ───────────────────────────────────────────────────────────
  function getSiblingInfo(el) {
    function describeEl(node) {
      if (!node) return null;
      return {
        tag    : node.tagName.toLowerCase(),
        id     : node.id || null,
        classes: Array.from(node.classList),
        text   : sanitizeName(node.textContent).slice(0, 40) || null,
        xpath  : getRelativeXPath(node),
      };
    }
    // Walk to find previous element sibling
    let prev = el.previousSibling;
    while (prev && prev.nodeType !== 1) prev = prev.previousSibling;
    let next = el.nextSibling;
    while (next && next.nodeType !== 1) next = next.nextSibling;
    return {
      previous: describeEl(prev),
      next    : describeEl(next),
    };
  }

  // ── Children summary ───────────────────────────────────────────────────────
  function getChildrenInfo(el) {
    const children = Array.from(el.children).slice(0, 10);
    return children.map(c => ({
      tag    : c.tagName.toLowerCase(),
      id     : c.id || null,
      classes: Array.from(c.classList),
      text   : sanitizeName(c.textContent).slice(0, 30) || null,
    }));
  }

  // ── Computed styles relevant to identification ─────────────────────────────
  function getKeyStyles(el) {
    const s = getComputedStyle(el);
    return {
      display   : s.display,
      visibility: s.visibility,
      cursor    : s.cursor,
      color     : s.color,
      background: s.backgroundColor,
      fontSize  : s.fontSize,
      fontWeight: s.fontWeight,
    };
  }

  // ── Bounding box ──────────────────────────────────────────────────────────
  function getBoundingBox(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  }

  // ── Position in parent ────────────────────────────────────────────────────
  function getPositionInParent(el) {
    if (!el.parentElement) return 1;
    return Array.from(el.parentElement.children).indexOf(el) + 1;
  }

  // ── Interactive element selector ──────────────────────────────────────────
  const INTERACTIVE_SELECTORS = [
    'button:not([disabled])',
    'input:not([type="hidden"]):not([disabled])',
    'textarea:not([disabled])',
    'select:not([disabled])',
    'a[href]',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="option"]',
    '[onclick]',
    '[data-testid]',
    '[data-cy]',
    '[tabindex]:not([tabindex="-1"])',
    'form',
    'label[for]',
    'nav a',
  ].join(', ');

  // ── Main extraction ────────────────────────────────────────────────────────
  const seen = new Set();
  const results = [];
  const nameCount = {};

  const elements = Array.from(document.querySelectorAll(INTERACTIVE_SELECTORS));

  for (const el of elements) {
    // Skip hidden, inside shadow DOM outer wrapper, or duplicates
    if (!isVisible(el)) continue;
    const absXp = getAbsoluteXPath(el);
    if (seen.has(absXp)) continue;
    seen.add(absXp);

    let locatorName = getLocatorName(el);

    // Deduplicate names: Login_Button, Login_Button_2, Login_Button_3 ...
    if (nameCount[locatorName]) {
      nameCount[locatorName]++;
      locatorName = locatorName + '_' + nameCount[locatorName];
    } else {
      nameCount[locatorName] = 1;
    }

    const relXPath = getRelativeXPath(el);
    const absXPath = getAbsoluteXPath(el);
    const css      = getCssSelector(el);
    const attrs    = getAllAttributes(el);

    // Build locator entries (one per strategy)
    const locators = [];

    if (attrs.id)
      locators.push({ type: 'ID',       value: '#' + attrs.id });

    locators.push({ type: 'CSS',      value: css });
    locators.push({ type: 'XPath',    value: relXPath });
    locators.push({ type: 'XPath_Abs', value: absXPath });

    if (attrs['data-testid'])
      locators.push({ type: 'TestID',  value: '[data-testid="' + attrs['data-testid'] + '"]' });
    if (attrs['aria-label'])
      locators.push({ type: 'AriaLabel', value: '[aria-label="' + attrs['aria-label'] + '"]' });
    if (attrs.name && el.tagName !== 'FORM')
      locators.push({ type: 'Name',    value: '[name="' + attrs.name + '"]' });
    if ((el.tagName === 'A' || el.tagName === 'BUTTON') && el.textContent.trim())
      locators.push({ type: 'Text',    value: sanitizeName(el.textContent).slice(0, 80) });

    results.push({
      locatorName,
      element: {
        tag        : el.tagName.toLowerCase(),
        type       : attrs.type || null,
        text       : sanitizeName(el.textContent).slice(0, 80) || null,
        isVisible  : true,
        isDisabled : el.disabled || el.getAttribute('aria-disabled') === 'true' || false,
        positionInParent: getPositionInParent(el),
        boundingBox: getBoundingBox(el),
        computedRole: el.getAttribute('role') || el.tagName.toLowerCase(),
      },
      attributes: attrs,
      locators,
      parent  : getParentInfo(el),
      siblings: getSiblingInfo(el),
      children: getChildrenInfo(el),
      styles  : getKeyStyles(el),
    });
  }

  return results;
})()
`;

// ─── Node.js writer functions ─────────────────────────────────────────────────

/**
 * Extract element DNA from page and write CSV + JSON files.
 * @param {Page}   page       Playwright page object
 * @param {string} pageName   e.g. "Dashboard_Overview" (sanitized)
 * @param {string} outputDir  absolute path to output folder
 */
async function extractAndSave(page, pageName, outputDir) {
  try {
    const elements = await page.evaluate(ELEMENT_DNA_SCRIPT);

    if (!elements || elements.length === 0) {
      console.log(`[DNA]    No interactive elements found on ${pageName}`);
      return;
    }

    // ── Write CSV ──────────────────────────────────────────────────────────
    const csvPath = path.join(outputDir, `${pageName}_locators.csv`);
    const csvLines = ['PageName,LocatorName,LocatorType,LocatorValue'];

    for (const el of elements) {
      for (const loc of el.locators) {
        // Escape values for CSV (wrap in quotes, escape internal quotes)
        const safe = v => '"' + String(v || '').replace(/"/g, '""') + '"';
        csvLines.push([
          safe(pageName),
          safe(el.locatorName),
          safe(loc.type),
          safe(loc.value),
        ].join(','));
      }
    }

    fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf8');
    console.log(`[CSV]    ${pageName}_locators.csv  (${elements.length} elements, ${csvLines.length - 1} locator rows)`);

    // ── Write full DNA JSON ────────────────────────────────────────────────
    const jsonPath = path.join(outputDir, `${pageName}_dna.json`);
    const dnaOutput = {
      pageName,
      capturedAt  : new Date().toISOString(),
      url         : page.url(),
      elementCount: elements.length,
      elements,
    };
    fs.writeFileSync(jsonPath, JSON.stringify(dnaOutput, null, 2), 'utf8');
    console.log(`[DNA]    ${pageName}_dna.json`);

  } catch (err) {
    console.error(`[DNA ERROR] ${pageName}: ${err.message}`);
  }
}

module.exports = { extractAndSave, ELEMENT_DNA_SCRIPT };
