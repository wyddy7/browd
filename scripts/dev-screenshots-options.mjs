#!/usr/bin/env node
/**
 * Browd options-page screenshot harness — local dev tool.
 *
 * Renders the built options page (`dist/options/index.html`) under headless
 * Chromium and captures full-page screenshots per tab × per theme, with
 * `chrome.*` APIs stubbed so the React + storage code runs inside `file://`.
 *
 * USAGE
 *   pnpm build                                           # build dist/ first
 *   node scripts/dev-screenshots-options.mjs [outSubdir]
 *
 *   outSubdir defaults to "output/screenshots-current". Each run produces:
 *     {tab}-{theme}.png             for tab in [general, models, firewall]
 *                                   × theme in [light, dark]
 *     general-light-legacy.png      additional variant — agentMode='legacy'
 *                                   shows the Legacy-mode-only section
 *
 *   The `output/` directory is gitignored.
 *
 * USEFUL FOR
 * - Visual review during design passes (see auto-docs/for-frontend/browd.DESIGN.md
 *   for the manifest the reviewer compares against).
 * - Regression diffs after refactors that touch settings UI.
 * - Producing fresh CWS store-listing screenshots if the options page changes
 *   substantially between updates.
 *
 * STORAGE KEY SHAPES (discovered 2026-05-15 — keep updated when storage changes)
 *   `general-settings`           GeneralSettingsConfig — all of options page general tab
 *   `firewall-settings`          { enabled, allowList[], denyList[] }
 *   `agent-models`               agent-role → model assignment map
 *   `provider-settings`          configured LLM providers + API keys
 *   `llm-providers`              (legacy/derived) providers list
 *   `speech-to-text-settings`    STT model selection
 *   `judge-settings`             judge-role model
 *   `runtime-judge-settings`     runtime judge config
 *   `agent-tab-focus`            current agent tab id (runtime)
 *
 * Empty `agent-models` / `provider-settings` yield the "No providers
 * configured yet" empty state — that itself is a useful screenshot.
 *
 * GOTCHAS
 * - `packages/i18n/lib/type.ts` is GENERATED — `pnpm build` regenerates it.
 *   Revert before committing (`git checkout -- packages/i18n/lib/type.ts`).
 *   Or skip i18n build when iterating only on tsx files.
 * - System Chrome may not be installed → script falls back to Brave / Chromium.
 *   Edit `CHROME_CANDIDATES` if a different binary is preferred.
 * - The prettier pre-commit hook reformats multi-line JSX const declarations
 *   into single-line. Expected behavior; not a bug.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// puppeteer-core is in `chrome-extension/node_modules/` because pnpm does not
// hoist it to root in this workspace.
const PUPPETEER_PATH = path.resolve(
  REPO_ROOT,
  'chrome-extension/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js',
);
const puppeteer = (await import(pathToFileURL(PUPPETEER_PATH).href)).default;

// Try Chrome first; fall back to Chromium then Brave (same engine).
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
];
const CHROME = (() => {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('No Chromium-family browser found in: ' + CHROME_CANDIDATES.join(', '));
})();

const OPTIONS_URL = pathToFileURL(path.join(REPO_ROOT, 'dist/options/index.html')).href;
const OUT_SUBDIR = process.argv[2] || 'output/screenshots-current';
const OUT_DIR = path.isAbsolute(OUT_SUBDIR) ? OUT_SUBDIR : path.join(REPO_ROOT, OUT_SUBDIR);
const MESSAGES_PATH = path.join(REPO_ROOT, 'packages/i18n/locales/en/messages.json');

if (!fs.existsSync(path.join(REPO_ROOT, 'dist/options/index.html'))) {
  console.error('dist/options/index.html not found — run `pnpm build` first.');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const messages = JSON.parse(fs.readFileSync(MESSAGES_PATH, 'utf-8'));

const BASE_GENERAL = {
  appearanceTheme: 'light',
  interfaceLanguage: 'en',
  maxSteps: 15,
  maxActionsPerStep: 10,
  maxFailures: 3,
  useVision: true,
  useVisionForPlanner: false,
  planningInterval: 3,
  displayHighlights: true,
  minWaitPageLoad: 750,
  replayHistoricalTasks: false,
  launchShortcut: 'Ctrl+E',
  agentMode: 'unified',
  visionMode: 'always',
};

const BASE_FIREWALL = {
  enabled: true,
  allowList: ['github.com', 'wyddy.tech'],
  denyList: ['evil.example.com'],
};

function buildInitialStorage({ theme, variant }) {
  const general = {
    ...BASE_GENERAL,
    appearanceTheme: theme,
    agentMode: variant === 'legacy' ? 'legacy' : 'unified',
  };
  return {
    'general-settings': general,
    'firewall-settings': BASE_FIREWALL,
    'agent-models': {},
    'provider-settings': {},
    'llm-providers': {},
    'speech-to-text-settings': {},
    'judge-settings': {},
    'runtime-judge-settings': {},
    'agent-tab-focus': {},
  };
}

function buildStubScript(initialStorage, messagesObj, prefersDark) {
  const storageJson = JSON.stringify(initialStorage);
  const messagesJson = JSON.stringify(messagesObj);
  return `
(() => {
  const __store = ${storageJson};
  const __messages = ${messagesJson};
  const __prefersDark = ${prefersDark ? 'true' : 'false'};

  const listeners = [];
  function emit(changes, areaName) {
    for (const l of listeners) {
      try { l(changes, areaName); } catch (e) { console.error('storage listener error', e); }
    }
  }

  function makeArea(area) {
    return {
      get(keys, cb) {
        let result = {};
        if (keys == null) {
          result = { ...__store };
        } else if (typeof keys === 'string') {
          if (keys in __store) result[keys] = __store[keys];
        } else if (Array.isArray(keys)) {
          for (const k of keys) {
            if (k in __store) result[k] = __store[k];
          }
        } else if (typeof keys === 'object') {
          for (const k of Object.keys(keys)) {
            result[k] = (k in __store) ? __store[k] : keys[k];
          }
        }
        if (typeof cb === 'function') { cb(result); return; }
        return Promise.resolve(result);
      },
      set(items, cb) {
        const changes = {};
        for (const k of Object.keys(items)) {
          changes[k] = { oldValue: __store[k], newValue: items[k] };
          __store[k] = items[k];
        }
        emit(changes, area);
        if (typeof cb === 'function') { cb(); return; }
        return Promise.resolve();
      },
      remove(keys, cb) {
        const arr = Array.isArray(keys) ? keys : [keys];
        const changes = {};
        for (const k of arr) {
          changes[k] = { oldValue: __store[k], newValue: undefined };
          delete __store[k];
        }
        emit(changes, area);
        if (typeof cb === 'function') { cb(); return; }
        return Promise.resolve();
      },
      clear(cb) {
        const changes = {};
        for (const k of Object.keys(__store)) {
          changes[k] = { oldValue: __store[k], newValue: undefined };
          delete __store[k];
        }
        emit(changes, area);
        if (typeof cb === 'function') { cb(); return; }
        return Promise.resolve();
      },
      onChanged: {
        addListener(l) { listeners.push(l); },
        removeListener(l) {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
      setAccessLevel() { return Promise.resolve(); },
    };
  }

  const localArea = makeArea('local');
  const syncArea = makeArea('sync');
  const sessionArea = makeArea('session');

  const storageRoot = {
    local: localArea,
    sync: syncArea,
    session: sessionArea,
    managed: makeArea('managed'),
    onChanged: {
      addListener(l) { listeners.push(l); },
      removeListener(l) {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
  };

  const tabsStub = {
    create(opts) { console.log('[stub] chrome.tabs.create', opts && opts.url); return Promise.resolve({ id: 1 }); },
    query() { return Promise.resolve([]); },
    update() { return Promise.resolve(); },
    get() { return Promise.resolve({ id: 1 }); },
    sendMessage() { return Promise.resolve(); },
    onUpdated: { addListener() {}, removeListener() {} },
    onActivated: { addListener() {}, removeListener() {} },
    onRemoved: { addListener() {}, removeListener() {} },
  };

  const runtimeStub = {
    id: 'browd-options-stub',
    getURL(p) { return p; },
    getManifest() { return { version: '0.0.0-stub', manifest_version: 3 }; },
    sendMessage() { return Promise.resolve(); },
    connect() {
      return {
        onMessage: { addListener() {}, removeListener() {} },
        onDisconnect: { addListener() {}, removeListener() {} },
        postMessage() {},
        disconnect() {},
      };
    },
    onMessage: { addListener() {}, removeListener() {} },
    onConnect: { addListener() {}, removeListener() {} },
    onInstalled: { addListener() {}, removeListener() {} },
    lastError: undefined,
  };

  const i18nStub = {
    getMessage(key, substitutions) {
      const entry = __messages[key];
      if (!entry) return '';
      let msg = entry.message || '';
      if (substitutions && entry.placeholders) {
        const subs = Array.isArray(substitutions) ? substitutions : [substitutions];
        let i = 0;
        msg = msg.replace(/\\$([a-zA-Z0-9_]+)\\$/g, () => {
          const v = subs[i] != null ? subs[i] : '';
          i += 1;
          return v;
        });
      }
      return msg;
    },
    getUILanguage() { return 'en-US'; },
    getAcceptLanguages(cb) {
      if (typeof cb === 'function') { cb(['en-US', 'en']); return; }
      return Promise.resolve(['en-US', 'en']);
    },
  };

  const permissionsStub = {
    contains() { return Promise.resolve(true); },
    request() { return Promise.resolve(true); },
    getAll() { return Promise.resolve({ permissions: [], origins: [] }); },
    onAdded: { addListener() {}, removeListener() {} },
    onRemoved: { addListener() {}, removeListener() {} },
  };

  const chromeStub = {
    storage: storageRoot,
    tabs: tabsStub,
    runtime: runtimeStub,
    i18n: i18nStub,
    permissions: permissionsStub,
    sidePanel: { open() { return Promise.resolve(); }, setOptions() { return Promise.resolve(); } },
    action: {
      onClicked: { addListener() {}, removeListener() {} },
      setBadgeText() { return Promise.resolve(); },
    },
    commands: {
      getAll() { return Promise.resolve([]); },
      onCommand: { addListener() {}, removeListener() {} },
    },
  };

  try {
    window.chrome = chromeStub;
  } catch (e) {}
  if (window.chrome !== chromeStub) {
    try {
      const existing = window.chrome || {};
      for (const k of Object.keys(chromeStub)) {
        try { existing[k] = chromeStub[k]; } catch (e) {}
      }
    } catch (e) {}
  }
  try { globalThis.chrome = window.chrome; } catch (e) {}

  const origMatchMedia = window.matchMedia ? window.matchMedia.bind(window) : null;
  window.matchMedia = function (query) {
    if (typeof query === 'string' && query.includes('prefers-color-scheme: dark')) {
      return {
        matches: __prefersDark,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() { return false; },
      };
    }
    if (origMatchMedia) return origMatchMedia(query);
    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() { return false; },
    };
  };
})();
`;
}

async function findHeadingForTab(page, tab) {
  const labels = {
    general: messages.options_general_section_appearance?.message,
    models: messages.options_models_providers_header?.message,
    firewall: messages.options_firewall_header?.message ||
              messages.options_firewall_section?.message ||
              'Firewall',
  };
  const target = labels[tab];
  await page.waitForFunction(
    (txt) => {
      const candidates = document.querySelectorAll('h1,h2,h3,button,span,div');
      for (const el of candidates) {
        if (el.textContent && el.textContent.trim() === txt) return true;
      }
      return false;
    },
    { timeout: 8000 },
    target,
  );
}

async function clickTab(page, tab) {
  const labelKey = `options_tabs_${tab}`;
  const label = messages[labelKey]?.message;
  if (!label) return;
  await page.evaluate((label) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find(b => b.textContent && b.textContent.trim() === label);
    if (btn) btn.click();
  }, label);
}

async function shoot({ browser, tab, theme, variant }) {
  const filename = variant === 'default'
    ? `${tab}-${theme}.png`
    : `${tab}-${theme}-${variant}.png`;
  const outPath = path.join(OUT_DIR, filename);

  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') {
      consoleErrors.push(`[${t}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    consoleErrors.push(`[pageerror] ${err.message}`);
  });

  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });

  const initial = buildInitialStorage({ theme, variant });
  const stubScript = buildStubScript(initial, messages, theme === 'dark');
  await page.evaluateOnNewDocument(stubScript);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme === 'dark' ? 'dark' : 'light' }]);

  await page.goto(OPTIONS_URL, { waitUntil: 'networkidle0', timeout: 20000 });

  if (tab !== 'models') {
    await page.waitForSelector('button', { timeout: 8000 });
    await clickTab(page, tab);
  }

  try {
    await findHeadingForTab(page, tab);
  } catch (e) {
    consoleErrors.push(`[wait-heading-timeout] tab=${tab} theme=${theme} variant=${variant}: ${e.message}`);
  }

  await new Promise((r) => setTimeout(r, 400));

  await page.screenshot({ path: outPath, fullPage: true });
  const stat = fs.statSync(outPath);
  await page.close();
  return { outPath, bytes: stat.size, consoleErrors };
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--allow-file-access-from-files'],
  });

  const combos = [];
  for (const tab of ['general', 'models', 'firewall']) {
    for (const theme of ['light', 'dark']) {
      combos.push({ tab, theme, variant: 'default' });
    }
  }
  combos.push({ tab: 'general', theme: 'light', variant: 'legacy' });

  const results = [];
  for (const combo of combos) {
    try {
      const r = await shoot({ browser, ...combo });
      results.push({ ...combo, ...r, ok: true });
      console.log(`OK  ${path.basename(r.outPath)}  ${r.bytes} bytes`);
      if (r.consoleErrors.length) {
        console.log('  console:');
        for (const line of r.consoleErrors.slice(0, 8)) console.log('    ' + line);
      }
    } catch (e) {
      console.log(`FAIL ${combo.tab}-${combo.theme}-${combo.variant}: ${e.message}`);
      results.push({ ...combo, ok: false, error: e.message });
    }
  }

  await browser.close();

  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} screenshots written to ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
