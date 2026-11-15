'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const {
  FLOW_HOME_URL,
  getChromeProfileDir,
  ensureDir,
  loadState,
} = require('./state');

function resolveBrowserExecutable() {
  const envPath = process.env.FLOW_BROWSER_PATH || process.env.CHROME_PATH;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  const candidates = [
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function isCdpReachable(cdpUrl) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`${cdpUrl}/json/version`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function waitForCdp(cdpUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await isCdpReachable(cdpUrl);
    if (info) return info;
    await new Promise((r) => setTimeout(r, 350));
  }
  throw new Error(`Timed out waiting for Chrome DevTools Protocol at ${cdpUrl}`);
}

async function ensureCdpBrowserRunning({ port, startUrl = FLOW_HOME_URL } = {}) {
  const state = loadState();
  const cdpPort = Number(port || state.cdpPort || 9222);
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;

  const existing = await isCdpReachable(cdpUrl);
  if (existing) {
    return { cdpUrl, cdpPort, launched: false, versionInfo: existing };
  }

  const exePath = resolveBrowserExecutable();
  if (!exePath) {
    throw new Error(
      'Could not locate Chrome, Edge, or Brave executable. Set FLOW_BROWSER_PATH to your browser binary.'
    );
  }

  const profileDir = getChromeProfileDir();
  ensureDir(profileDir);

  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    startUrl,
  ];

  const child = spawn(exePath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();

  const versionInfo = await waitForCdp(cdpUrl, 15000);
  return { cdpUrl, cdpPort, launched: true, exePath, profileDir, versionInfo };
}

function isFlowUrl(url) {
  if (!url) return false;
  return (
    /labs\.google\/fx(?:\/|$)/i.test(url) ||
    /flow\.google(?:\.com)?/i.test(url) ||
    /accounts\.google\.com/i.test(url)
  );
}

function isGoogleFlowAppUrl(url) {
  if (!url) return false;
  return /labs\.google\/fx\/.*flow/i.test(url) || /flow\.google(?:\.com)?/i.test(url);
}

function isProjectUrl(url) {
  return Boolean(url && /\/projects?\/[a-zA-Z0-9_-]+/i.test(url));
}

function sameProjectOrUrl(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const ma = String(a).match(/\/projects?\/([a-zA-Z0-9_-]+)/i);
  const mb = String(b).match(/\/projects?\/([a-zA-Z0-9_-]+)/i);
  return Boolean(ma && mb && ma[1] === mb[1]);
}

async function connectToFlow({
  targetUrl = null,
  bringToFront = false,
  requireProject = false,
  waitUntil = 'domcontentloaded',
} = {}) {
  const state = loadState();
  const preferredProjectUrl = (state.currentProject && state.currentProject.webUrl) || null;
  const startUrl = targetUrl || preferredProjectUrl || FLOW_HOME_URL;
  const cdpInfo = await ensureCdpBrowserRunning({ port: state.cdpPort, startUrl });

  const browser = await chromium.connectOverCDP(cdpInfo.cdpUrl);
  const contexts = browser.contexts();
  const context = contexts[0] || (await browser.newContext());

  const allPages = contexts.flatMap((ctx) => ctx.pages());
  const scorePage = (p) => {
    const u = p.url() || '';
    if (targetUrl && sameProjectOrUrl(u, targetUrl)) return 5;
    if (preferredProjectUrl && sameProjectOrUrl(u, preferredProjectUrl)) return 4;
    if (isProjectUrl(u) && isGoogleFlowAppUrl(u)) return 3;
    if (isGoogleFlowAppUrl(u)) return 2;
    if (isFlowUrl(u)) return 1;
    return 0;
  };

  let page = null;
  let bestScore = 0;
  for (const p of allPages) {
    const s = scorePage(p);
    if (s > bestScore) {
      bestScore = s;
      page = p;
    }
  }

  // Close duplicate bare home tabs (https://flow.google.com/) when multiple Flow tabs are open
  const flowTabs = allPages.filter((p) => isGoogleFlowAppUrl(p.url()));
  if (flowTabs.length > 1) {
    for (const p of flowTabs) {
      if (p !== page && !isProjectUrl(p.url())) {
        await p.close().catch(() => {});
      }
    }
  }

  let didNavigate = false;
  if (!page) {
    const existingPages = context.pages();
    const blankPage = existingPages.find((p) => {
      const u = p.url();
      return !u || u === 'about:blank' || u.startsWith('chrome://newtab');
    });
    page = blankPage || (await context.newPage());
    await page.goto(startUrl, { waitUntil, timeout: 30000 }).catch(() => {});
    didNavigate = true;
  } else if (targetUrl && !sameProjectOrUrl(page.url(), targetUrl)) {
    await page.goto(targetUrl, { waitUntil, timeout: 30000 }).catch(() => {});
    didNavigate = true;
  } else if (requireProject && !isProjectUrl(page.url()) && preferredProjectUrl) {
    await page.goto(preferredProjectUrl, { waitUntil, timeout: 30000 }).catch(() => {});
    didNavigate = true;
  }

  if (didNavigate) {
    const waitSelector = requireProject || isProjectUrl(page.url())
      ? 'div.ProseMirror[role="textbox"]'
      : 'div.ProseMirror[role="textbox"], .project-card';
    await page
      .locator(waitSelector)
      .first()
      .waitFor({ state: 'visible', timeout: 10000 })
      .catch(() => {});
  }

  if (bringToFront) {
    await page.bringToFront().catch(() => {});
  }

  return {
    browser,
    context,
    page,
    launched: cdpInfo.launched,
    cdpUrl: cdpInfo.cdpUrl,
  };
}

async function withFlowPage(options, handler) {
  let conn;
  try {
    conn = await connectToFlow(options);
    return await handler(conn);
  } finally {
    if (conn && conn.browser) {
      await conn.browser.close().catch(() => {});
    }
  }
}

module.exports = {
  resolveBrowserExecutable,
  isCdpReachable,
  ensureCdpBrowserRunning,
  isFlowUrl,
  isGoogleFlowAppUrl,
  connectToFlow,
  withFlowPage,
};
