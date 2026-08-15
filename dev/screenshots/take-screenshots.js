// Drives the seeded LoxSuite instance with Playwright to refresh every screenshot docs/screenshots/
// already has, in both themes, with the SAME 1440x900 viewport those files were originally captured
// at (see the "run" skill's own "drive it, don't just launch it" guidance) — every page's content is
// synthetic (see seed-screenshot-data.js/fake-miniserver.js), never real device/installation data.
const { chromium } = require('playwright-core');
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

async function shoot(page, name, theme) {
  await page.screenshot({ path: `${OUT_DIR}/${name}-${theme}.png` });
  console.log(`saved ${name}-${theme}.png`);
}

async function main() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('  [console]', msg.text()); });

  await login(page);

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
  }

  await browser.close();
  console.log('All screenshots captured.');
}

main().catch((err) => {
  console.error('Screenshot run failed:', err);
  process.exit(1);
});
