package com.yourcompany.capture;

import com.microsoft.playwright.*;
import com.microsoft.playwright.options.LoadState;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.*;
import java.util.regex.Pattern;

/**
 * HtmlCaptureService — Java / Playwright
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop this class into your existing Java project.
 * It mirrors the full Node.js utility feature-set:
 *
 *   • Auto-capture on load / navigation / DOM mutation
 *   • Floating "📸 Capture HTML" button injected on every page
 *   • Active internal-tab detection
 *   • Deduplication via DOM hash + cooldown
 *   • Files saved to src/resources/html-pages/PageTitle_TabName.html
 *
 * Dependencies (add to pom.xml / build.gradle — see setup doc):
 *   com.microsoft.playwright : playwright : 1.44.0
 * ─────────────────────────────────────────────────────────────────────────────
 */
public class HtmlCaptureService implements AutoCloseable {

    // ── Config ────────────────────────────────────────────────────────────────
    private final Path outputDir;
    private final long captureDelayMs;
    private final long cooldownMs;
    private final boolean headless;

    // ── State ─────────────────────────────────────────────────────────────────
    private final Map<String, PageSnapshot> captureState = new ConcurrentHashMap<>();
    private final ScheduledExecutorService scheduler = Executors.newScheduledThreadPool(4);

    // Playwright objects (one per service instance)
    private Playwright playwright;
    private Browser browser;

    // ── Inner snapshot record ─────────────────────────────────────────────────
    private record PageSnapshot(String hash, int length, long lastCapture) {}

    // ─── Constructor ──────────────────────────────────────────────────────────
    public HtmlCaptureService(Path outputDir, boolean headless) {
        this.outputDir      = outputDir;
        this.captureDelayMs = 800;
        this.cooldownMs     = 1200;
        this.headless       = headless;

        try { Files.createDirectories(outputDir); }
        catch (IOException e) { throw new RuntimeException(e); }
    }

    // ── Start browser ─────────────────────────────────────────────────────────
    public Page openBrowser() {
        playwright = Playwright.create();
        browser    = playwright.chromium().launch(
            new BrowserType.LaunchOptions().setHeadless(headless)
        );
        BrowserContext ctx = browser.newContext();
        Page page = ctx.newPage();

        // Auto-inject on every new page/tab
        ctx.onPage(this::setupPage);
        setupPage(page);

        System.out.println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        System.out.println("  HTML Capture Service  —  Java / Playwright        ");
        System.out.println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        System.out.println("  Output dir : " + outputDir);
        System.out.println("  Headless   : " + headless);
        System.out.println("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        return page;
    }

    // ── Per-page setup ────────────────────────────────────────────────────────
    private void setupPage(Page page) {

        // Expose: DOM mutation callback from browser → Java
        page.exposeFunction("__onDomChanged", args -> {
            scheduledCapture(page, "dom-mutation");
            return null;
        });

        // Expose: Manual button click callback
        page.exposeFunction("__onManualCapture", args -> {
            forceCapture(page, "manual-button");
            return null;
        });

        // Expose: Tab click callback
        page.exposeFunction("__onTabClick", args -> {
            scheduledCapture(page, "tab-click");
            return null;
        });

        // Inject on every load
        page.onLoad(p -> {
            injectAll(p);
            scheduledCapture(p, "page-load");
        });

        page.onDOMContentLoaded(this::injectAll);

        page.onFrameNavigated(frame -> {
            if (frame.equals(page.mainFrame())) {
                scheduledCapture(page, "navigation");
            }
        });

        // URL polling for SPA hash/pushState changes
        final String[] lastUrl = { page.url() };
        scheduler.scheduleAtFixedRate(() -> {
            try {
                String cur = page.url();
                if (!cur.equals(lastUrl[0])) {
                    lastUrl[0] = cur;
                    scheduledCapture(page, "url-change");
                }
            } catch (Exception ignored) {}
        }, 500, 500, TimeUnit.MILLISECONDS);
    }

    private final Map<Page, ScheduledFuture<?>> pendingCaptures = new ConcurrentHashMap<>();

    private void scheduledCapture(Page page, String reason) {
        ScheduledFuture<?> prev = pendingCaptures.get(page);
        if (prev != null) prev.cancel(false);
        ScheduledFuture<?> future = scheduler.schedule(
            () -> captureIfChanged(page, reason),
            captureDelayMs, TimeUnit.MILLISECONDS
        );
        pendingCaptures.put(page, future);
    }

    // ── Inject MutationObserver + floating button into page ───────────────────
    private void injectAll(Page page) {
        try {
            page.evaluate(MUTATION_OBSERVER_SCRIPT);
            page.evaluate(FLOATING_BUTTON_SCRIPT);
            page.evaluate(TAB_CLICK_LISTENER_SCRIPT);
        } catch (Exception ignored) {}
    }

    // ── Core capture ──────────────────────────────────────────────────────────
    private synchronized void captureIfChanged(Page page, String reason) {
        try {
            String url = page.url();
            if (url == null || url.equals("about:blank")) return;

            String title   = page.title();
            Object tabRaw  = page.evaluate(TAB_DETECTOR_SCRIPT);
            String tabName = tabRaw != null ? tabRaw.toString() : null;

            @SuppressWarnings("unchecked")
            Map<String,Object> fp = (Map<String,Object>) page.evaluate(DOM_FINGERPRINT_SCRIPT);
            int    length      = fp != null ? ((Number) fp.getOrDefault("length", 0)).intValue() : 0;
            String visibleText = fp != null ? (String) fp.getOrDefault("visibleText", "") : "";

            String domHash      = md5(visibleText + length);
            String pageIdentity = sanitize(title) + "__" + sanitize(tabName != null ? tabName : "default");
            long   now          = System.currentTimeMillis();

            PageSnapshot prev = captureState.get(pageIdentity);
            if (prev != null) {
                boolean unchanged = prev.hash().equals(domHash) && prev.length() == length;
                boolean tooSoon   = (now - prev.lastCapture()) < cooldownMs;
                if (unchanged || tooSoon) return;
            }

            String html      = page.content();
            String pageTitle = sanitize(title).isEmpty() ? "Page" : sanitize(title);
            String tabLabel  = tabName != null && !sanitize(tabName).isEmpty()
                               ? sanitize(tabName) : "Default";
            String fileName  = pageTitle + "_" + tabLabel + ".html";
            Path   filePath  = outputDir.resolve(fileName);

            String output = "<!-- captured: " + Instant.now() + " | reason: " + reason
                          + " | url: " + url + " -->\n" + html;
            Files.writeString(filePath, output, StandardCharsets.UTF_8);

            captureState.put(pageIdentity, new PageSnapshot(domHash, length, now));
            System.out.printf("[CAPTURE] %s  ← %s%n", fileName, reason);

        } catch (Exception e) {
            System.err.println("[CAPTURE ERROR] " + e.getMessage());
        }
    }

    /** Force a capture even if DOM hash hasn't changed (manual button). */
    private void forceCapture(Page page, String reason) {
        try {
            String url      = page.url();
            String title    = page.title();
            Object tabRaw   = page.evaluate(TAB_DETECTOR_SCRIPT);
            String tabName  = tabRaw != null ? tabRaw.toString() : null;
            String html     = page.content();
            String pageTitle = sanitize(title).isEmpty() ? "Page" : sanitize(title);
            String tabLabel  = tabName != null && !sanitize(tabName).isEmpty()
                               ? sanitize(tabName) : "Default";
            String fileName  = pageTitle + "_" + tabLabel + "_" + System.currentTimeMillis() + ".html";
            Path   filePath  = outputDir.resolve(fileName);
            String output    = "<!-- manual-force: " + Instant.now() + " | url: " + url + " -->\n" + html;
            Files.writeString(filePath, output, StandardCharsets.UTF_8);
            System.out.printf("[MANUAL]  %s  (forced)%n", fileName);
        } catch (Exception e) {
            System.err.println("[MANUAL CAPTURE ERROR] " + e.getMessage());
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    private static final Pattern SANITIZE_PATTERN = Pattern.compile("[^a-zA-Z0-9_\\-]");
    private static final Pattern MULTI_UNDERSCORE = Pattern.compile("_+");

    private static String sanitize(String s) {
        if (s == null || s.isBlank()) return "Unknown";
        String r = SANITIZE_PATTERN.matcher(s).replaceAll("_");
        r = MULTI_UNDERSCORE.matcher(r).replaceAll("_");
        r = r.replaceAll("^_|_$", "");
        return r.length() > 60 ? r.substring(0, 60) : r;
    }

    private static String md5(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) sb.append(String.format("%02x", b));
            return sb.substring(0, 12);
        } catch (Exception e) { return "000000000000"; }
    }

    @Override
    public void close() {
        scheduler.shutdownNow();
        if (browser != null) browser.close();
        if (playwright != null) playwright.close();
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  JavaScript strings (same logic as Node.js version)
    // ─────────────────────────────────────────────────────────────────────────

    private static final String TAB_DETECTOR_SCRIPT = """
        (() => {
          const ariaTab = document.querySelector('[role="tab"][aria-selected="true"]');
          if (ariaTab) return (ariaTab.textContent || ariaTab.getAttribute('aria-label') || '').trim();
          const patterns = [
            '.tab.active','.tab.selected','.tab--active','.tab--selected',
            '.nav-link.active','.nav-item.active > a','.nav-tab.active',
            '[class*="tab"][class*="active"]','[class*="tab"][class*="selected"]',
            '.is-active[role="tab"]','.current[role="tab"]',
            'li.active > a','button.active[data-tab]'
          ];
          for (const sel of patterns) {
            try { const el=document.querySelector(sel); if(el){ const t=el.textContent.trim(); if(t) return t; } }
            catch(_){}
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
        """;

    private static final String DOM_FINGERPRINT_SCRIPT = """
        (() => {
          const b=document.body;
          if(!b) return {length:0,visibleText:''};
          return {length:b.innerHTML.length, visibleText:(b.innerText||'').slice(0,2000)};
        })()
        """;

    private static final String MUTATION_OBSERVER_SCRIPT = """
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
        """;

    private static final String TAB_CLICK_LISTENER_SCRIPT = """
        if (!window.__tabListenerAdded) {
          window.__tabListenerAdded = true;
          document.addEventListener('click', e => {
            const el=e.target.closest('[role="tab"],.tab,.nav-link,.nav-tab,[class*="tab"]');
            if(el&&window.__onTabClick) window.__onTabClick();
          }, true);
        }
        """;

    private static final String FLOATING_BUTTON_SCRIPT = """
        (() => {
          if (document.getElementById('__htmlCaptureBtn')) return;
          const btn = document.createElement('button');
          btn.id = '__htmlCaptureBtn';
          btn.innerText = '\\uD83D\\uDCF8 Capture HTML';
          Object.assign(btn.style, {
            position:'fixed', top:'14px', right:'14px', zIndex:'2147483647',
            padding:'8px 14px', background:'#4F46E5', color:'#fff',
            border:'none', borderRadius:'8px', fontSize:'13px',
            fontFamily:'system-ui,sans-serif', fontWeight:'600',
            cursor:'pointer', boxShadow:'0 2px 8px rgba(0,0,0,0.25)',
            transition:'background 0.15s,transform 0.1s', userSelect:'none',
          });
          btn.addEventListener('mouseover', () => btn.style.background='#3730A3');
          btn.addEventListener('mouseout',  () => { if(!btn._active) btn.style.background='#4F46E5'; });
          btn.addEventListener('click', async () => {
            if(btn._active) return;
            btn._active=true;
            const orig=btn.innerText;
            btn.innerText='\\u23F3 Capturing\\u2026';
            btn.style.background='#6B7280';
            btn.style.transform='scale(0.96)';
            try {
              await window.__onManualCapture();
              btn.innerText='\\u2705 Saved!';
              btn.style.background='#16A34A';
            } catch(e) {
              btn.innerText='\\u274C Error';
              btn.style.background='#DC2626';
            }
            setTimeout(()=>{btn.innerText=orig;btn.style.background='#4F46E5';
              btn.style.transform='scale(1)';btn._active=false;},1800);
          });
          document.documentElement.appendChild(btn);
        })();
        """;

    // ─────────────────────────────────────────────────────────────────────────
    //  Main — quick demo / sanity check
    // ─────────────────────────────────────────────────────────────────────────
    public static void main(String[] args) throws Exception {
        Path out = Path.of("src/resources/html-pages");
        try (HtmlCaptureService svc = new HtmlCaptureService(out, false)) {
            Page page = svc.openBrowser();
            System.out.println("[READY] Browser open. Navigate freely.");
            System.out.println("[READY] Click '📸 Capture HTML' for a manual snapshot.");
            // Keep running until Ctrl+C
            Thread.currentThread().join();
        }
    }
}
