// Drives the seeded LoxSuite instance with Playwright to refresh every screenshot docs/screenshots/
// already has, in both themes, with the SAME 1440x900 viewport those files were originally captured
// at (see the "run" skill's own "drive it, don't just launch it" guidance) — every page's content is
// synthetic (see seed-screenshot-data.js/fake-miniserver.js), never real device/installation data.
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { ({ chromium } = require('playwright')); }
const fs = require('fs');

const PORT = process.env.APP_PORT || '15590';
const BASE = `http://127.0.0.1:${PORT}`;
const OUT_DIR = process.env.SHOTS_DIR || '/data/shots';
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin12345678';
fs.mkdirSync(OUT_DIR, { recursive: true });

async function setTheme(page, theme) {
  await page.evaluate((t) => localStorage.setItem('theme', t), theme);
}

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="username"]', ADMIN_USERNAME);
  await page.fill('input[name="password"]', ADMIN_PASSWORD);
  await Promise.all([page.waitForNavigation(), page.click('button[type="submit"]')]);
}

// opts.fullPage: the whole page, taken by making the window as tall as the page (a plain fullPage
// screenshot would stop the sidebar at the first screen, since it is one window high).
async function shoot(page, name, theme, opts = {}) {
  if (opts.fullPage) {
    const vp = page.viewportSize();
    const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight));
    await page.setViewportSize({ width: vp.width, height: Math.min(Math.max(h, vp.height), 6000) });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT_DIR}/${name}-${theme}.png` });
    await page.setViewportSize(vp);
  } else {
    await page.screenshot({ path: `${OUT_DIR}/${name}-${theme}.png` });
  }
  console.log(`saved ${name}-${theme}.png`);
}

// Map tiles without internet (OFFLINE_TILES=1): a plain street-map look drawn per tile, so the car
// map on the vehicle pages isn't empty. With internet the real OpenStreetMap tiles are used.
function fakeTile(z, x, y) {
  let seed = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#f2efe9"/>';
  if (rnd() < 0.35) svg += `<rect x="${Math.round(rnd() * 150)}" y="${Math.round(rnd() * 150)}" width="${60 + Math.round(rnd() * 80)}" height="${50 + Math.round(rnd() * 70)}" rx="8" fill="#cdebb0"/>`;
  if (rnd() < 0.2) svg += `<path d="M0 ${Math.round(rnd() * 256)} C 90 ${Math.round(rnd() * 256)}, 170 ${Math.round(rnd() * 256)}, 256 ${Math.round(rnd() * 256)}" stroke="#aad3df" stroke-width="14" fill="none"/>`;
  for (let i = 0; i < 6; i++) {
    const v = rnd() < 0.5; const p = Math.round(rnd() * 256); const w = rnd() < 0.25 ? 7 : 3.5;
    svg += v ? `<line x1="${p}" y1="0" x2="${p + Math.round(rnd() * 40 - 20)}" y2="256" stroke="#fff" stroke-width="${w}"/>` : `<line x1="0" y1="${p}" x2="256" y2="${p + Math.round(rnd() * 40 - 20)}" stroke="#fff" stroke-width="${w}"/>`;
  }
  if (rnd() < 0.3) svg += `<line x1="0" y1="${Math.round(rnd() * 256)}" x2="256" y2="${Math.round(rnd() * 256)}" stroke="#f9b29c" stroke-width="6"/>`;
  return svg + '</svg>';
}

// Fold (or with open = true unfold) the cards with these titles; leaves cards already in that state.
async function fold(page, titles, open = false) {
  for (const t of titles) {
    const btn = page.locator('.card h2', { hasText: t }).locator('.card-collapse-btn').first();
    if (!(await btn.count())) continue;
    const folded = await btn.evaluate((b) => b.closest('.card').classList.contains('card-collapsed'));
    if (folded === open) await btn.click();
  }
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Europe/Amsterdam', locale: 'en-GB' });
  const page = await context.newPage();
  if (process.env.OFFLINE_TILES === '1') {
    await context.route('**/tile.openstreetmap.org/**', (route) => {
      const m = /\/(\d+)\/(\d+)\/(\d+)\.png/.exec(route.request().url());
      route.fulfill({ status: 200, contentType: 'image/svg+xml', body: fakeTile(+m[1], +m[2], +m[3]) });
    });
  }
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('  [console]', msg.text()); });

  await login(page);
  // fetch prices, solar forecast and fuel first and re-plan, so the charging plan includes the sun
  const recalc = await page.evaluate(() => fetch('/planner/recalc.json', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prices: true, solar: true, fuel: true }),
  }).then((r) => r.status));
  console.log('  recalc', recalc);

  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);

    // ---- dashboard ----
    // Collapse the Status/Load/Miniservers admin-status sections above the actual Panels grid —
    // left expanded (their default for a session with no saved preference yet), they push every
    // chart/gauge/value panel below the fold, which is what made the very first attempt at this
    // screenshot effectively "a screenshot of connection status," not "a screenshot of a
    // dashboard" (see the docs/screenshots' own dashboard-*.png alt text: it's specifically about
    // the panels, same as My Dashboards would show with none of these three sections at all).
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    for (const section of ['home-status', 'home-load', 'home-miniservers']) {
      const toggle = page.locator(`.section-toggle[data-nav-section="${section}"]`);
      if (await toggle.count() && (await toggle.getAttribute('aria-expanded')) === 'true') {
        await toggle.click();
      }
    }
    await page.waitForTimeout(800); // charts finish drawing
    await shoot(page, 'dashboard', theme);

    // ---- dashboard-chart-types: a separate, purpose-built personal dashboard (My Dashboards ->
    // "Chart types", see seed-screenshot-data.js) — the same 5 monitors shown as line/bar/
    // doughnut/radar/gauge/stat-with-change, matching this screenshot's own long-standing alt text.
    await page.goto(`${BASE}/dashboards`, { waitUntil: 'networkidle' });
    await page.click('a:has-text("Chart types")');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(800); // charts finish drawing
    await shoot(page, 'dashboard-chart-types', theme);

    // ---- monitor-detail ----
    await page.goto(`${BASE}/monitor/1`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await shoot(page, 'monitor-detail', theme);

    // ---- miniservers (+ diagnostics dialog) ----
    await page.goto(`${BASE}/miniservers`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    // Gateway/Client groups start collapsed on a fresh session — expand so both seeded Clients
    // under "Main House" actually show, matching the original screenshot's own alt text.
    const expandAllBtn = page.locator('button:has-text("Expand all")');
    if (await expandAllBtn.count()) {
      await expandAllBtn.click();
      await page.waitForTimeout(200);
    }
    await shoot(page, 'miniservers', theme);

    await page.click('.row-actions-toggle');
    await page.waitForTimeout(200);
    await page.click('button:has-text("Diagnostics")');
    await page.waitForSelector('#ms-diag-dialog[open]');
    await page.waitForTimeout(300);
    await shoot(page, 'miniservers-diag', theme);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // ---- mappings ----
    await page.goto(`${BASE}/mappings/mqtt-to-loxone`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await shoot(page, 'mappings', theme);

    // ---- notification-center (popover) ----
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.click('#notification-center-btn');
    await page.waitForSelector('#notification-center-panel:not([hidden])');
    await page.waitForTimeout(300);
    await shoot(page, 'notification-center', theme);
    await page.keyboard.press('Escape');

    // ---- live-data (room expanded) ----
    await page.goto(`${BASE}/live-data`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const livingRoomToggle = page.locator('summary', { hasText: 'Living room' }).first();
    if (await livingRoomToggle.count()) {
      await livingRoomToggle.click();
      await page.waitForTimeout(500);
      // One level down: the room's own categories (Climate/Lighting/Shading) are each their own
      // <details>/<summary> too — expanding just the room shows the category LIST, not any actual
      // control/value rows, which only render once a category itself is opened.
      const lightingToggle = page.locator('summary', { hasText: 'Lighting' }).first();
      if (await lightingToggle.count()) {
        await lightingToggle.click();
        await page.waitForTimeout(1200); // live values fetch
      }
    }
    await shoot(page, 'live-data', theme);

    // ---- hardware ----
    await page.goto(`${BASE}/hardware`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await shoot(page, 'hardware', theme);

    // ---- backup ----
    await page.goto(`${BASE}/admin/backup`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await shoot(page, 'backup', theme);

    // ---- notifications (+ add-channel form filled with Discord) ----
    await page.goto(`${BASE}/admin/notifications`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await shoot(page, 'notifications', theme);

    await page.click('summary:has-text("Add channel")');
    await page.waitForTimeout(150);
    await page.locator('.channel-form:not([style*="display: none"]) .channel-service-select').first().selectOption('discord');
    await page.waitForTimeout(150);
    await page.locator('.channel-fields[data-service="discord"] input[data-field="webhookUrl"]').first()
      .fill('https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
    await page.waitForTimeout(200); // live Apprise-URL preview updates
    await shoot(page, 'notifications-add-channel', theme);

    // ---- security ----
    await page.goto(`${BASE}/admin/security`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await shoot(page, 'security', theme);

    // ================= Energy & charging (seed-energy-data.js) =================
    // Long pages are captured whole (fullPage) so the charts below the fold are in the picture.
    await page.goto(`${BASE}/planner`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    // the details of a planned hour below the chart
    const planned = await page.evaluate(() => {
      const bar = [...document.querySelectorAll('#pl-chart rect')].find((r) => r.getAttribute('fill') === 'var(--accent)');
      if (!bar) return -1;
      const x = Number(bar.getAttribute('x'));
      const hit = [...document.querySelectorAll('[data-pl-i]')].find((r) => Math.abs(Number(r.getAttribute('x')) - x) < 1);
      return hit ? Number(hit.getAttribute('data-pl-i')) : -1;
    });
    if (planned >= 0) { await page.locator(`[data-pl-i="${planned}"]`).dispatchEvent('click'); await page.waitForTimeout(500); }
    await shoot(page, 'smart-charging', theme, { fullPage: true });

    await page.goto(`${BASE}/energy`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await shoot(page, 'energy-meters', theme, { fullPage: true });

    await page.goto(`${BASE}/agenda`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    // a drop-off and pick-up, driving on to the garage after dropping off (a route)
    const care = () => page.locator('[data-key^="event|"]', { hasText: 'Day care' }).first();
    if (await care().count()) {
      await care().evaluate((e) => e.click());
      await page.waitForTimeout(800);
      const chain = page.locator('#ag-chain-start');
      if (await chain.count() && (await chain.inputValue()) !== '1') {
        await chain.selectOption('1');
        await page.waitForTimeout(3000); // the distance between the two looked up in the background
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);
        await care().evaluate((e) => e.click());
      }
      await page.waitForTimeout(800);
    }
    await shoot(page, 'agenda', theme);

    await page.goto(`${BASE}/learned`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await shoot(page, 'learned', theme, { fullPage: true });

    await page.goto(`${BASE}/vehicles`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    await fold(page, ['Add vehicle']);
    await shoot(page, 'vehicles', theme);

    await page.goto(`${BASE}/vehicles/1`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await page.evaluate(() => document.querySelectorAll('details').forEach((d) => { if (d.querySelector('#veh-monitor-picks')) d.open = true; }));
    await page.waitForTimeout(300);
    await shoot(page, 'vehicle', theme);

    await page.goto(`${BASE}/driving`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await fold(page, ['Recent trips']);
    await shoot(page, 'driving', theme, { fullPage: true });

    await page.goto(`${BASE}/energy-manager`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    await fold(page, ['Hot water', 'Washing machine']);
    await shoot(page, 'energy-manager', theme, { fullPage: true });

    // one consumer in detail: the heat pump with its on/off and mode signals (load 2 in the seed)
    await page.goto(`${BASE}/energy-manager/loads/2`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    await shoot(page, 'energy-load', theme, { fullPage: true });

    await page.goto(`${BASE}/ocpp/1`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    await fold(page, ['Status', 'Quarterly export', 'Sessions', 'Log']);
    await shoot(page, 'ocpp', theme, { fullPage: true });

    await page.goto(`${BASE}/settings/energy`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await shoot(page, 'settings-energy', theme);

    // ================= Administration: modules, languages =================
    await page.goto(`${BASE}/admin/modules`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await shoot(page, 'modules', theme);

    await page.goto(`${BASE}/translations?lang=nl`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await shoot(page, 'translations', theme);

    // Folded cards + compact hints: Settings with two cards folded (remembered per device)
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);
    await fold(page, ['Data retention', 'Health monitoring']);
    await page.waitForTimeout(300);
    await shoot(page, 'settings-folded', theme);
    await fold(page, ['Data retention', 'Health monitoring'], true); // unfold again

    // The same Smart charging page in Dutch (Profile → Language), then back to English
    await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle' });
    await page.selectOption('select[name="language"]', 'nl');
    await Promise.all([page.waitForNavigation(), page.click('form[action="/profile/language"] button[type="submit"]')]);
    await page.goto(`${BASE}/planner`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    await shoot(page, 'smart-charging-nl', theme);
    await page.goto(`${BASE}/profile`, { waitUntil: 'networkidle' });
    await page.selectOption('select[name="language"]', '');
    await Promise.all([page.waitForNavigation(), page.click('form[action="/profile/language"] button[type="submit"]')]);
  }

  await browser.close();
  console.log('All screenshots captured.');
}

main().catch((err) => {
  console.error('Screenshot run failed:', err);
  process.exit(1);
});
