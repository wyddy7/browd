/**
 * T1 web tools — read-only path that bypasses the browser DOM.
 *
 * Three tools land here:
 *   - web_fetch_markdown(url, maxChars)
 *   - web_search(query, topK)
 *   - extract_page_as_markdown(maxChars) — for the active tab
 *
 * All three are pure background-side fetch + Readability + Turndown.
 * They never open a tab, never click, and never touch the puppeteer
 * connection. Use them for information-seeking tasks; use the existing
 * browser tools for interactive flows.
 *
 * Read order before editing: auto-docs/browd-agent-evolution.md (Tier 1).
 */
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import TurndownService from 'turndown';
import { parseHTML } from 'linkedom';
import { createLogger } from '@src/background/log';

const logger = createLogger('WebTools');

export interface WebFetchResult {
  ok: true;
  url: string;
  title: string;
  markdown: string;
  truncated: boolean;
}

export interface WebFetchError {
  ok: false;
  errorType: 'transient' | 'auth_or_config' | 'parse_failed';
  message: string;
  url: string;
}

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResult {
  ok: true;
  engine: 'duckduckgo' | 'bing';
  results: WebSearchHit[];
}

export interface WebSearchError {
  ok: false;
  errorType: 'transient' | 'parse_failed';
  message: string;
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});

// Strip nav/footer/aside/script/style ahead of Readability — these tend to
// poison the readability score on agent-style sites that lack obvious main.
turndown.remove(['script', 'style', 'noscript', 'iframe']);

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n\n…[truncated, ${text.length - maxChars} chars hidden]`,
    truncated: true,
  };
}

/**
 * MV3 service workers do NOT have DOMParser, document, or window. We use
 * linkedom (`parseHTML`) which gives a spec-compliant Document implemented
 * in pure JS — works without DOM APIs. Readability and Turndown both
 * accept linkedom's Document and Element types.
 */
function htmlToMarkdown(html: string, sourceUrl: string): { title: string; markdown: string } {
  const { document: doc } = parseHTML(html);

  // Set the base URL so relative anchors resolve.
  try {
    const base = doc.createElement('base');
    base.href = sourceUrl;
    doc.head?.prepend(base);
  } catch {
    // Some hostile docs throw — ignore.
  }

  let title = doc.title || sourceUrl;
  let articleHtml = '';

  // linkedom's Document is structurally compatible with the Readability
  // input but the type cast is needed because @mozilla/readability ships
  // its own Document/Element types.
  const docForReader = doc as unknown as Document;
  if (isProbablyReaderable(docForReader)) {
    const reader = new Readability(docForReader.cloneNode(true) as Document);
    const article = reader.parse();
    if (article?.content) {
      articleHtml = article.content;
      title = article.title || title;
    }
  }

  // Fallback when Readability declined or returned nothing useful.
  if (!articleHtml) {
    const main = doc.querySelector('main') ?? doc.querySelector('article') ?? doc.body;
    articleHtml = main?.innerHTML ?? doc.body?.innerHTML ?? '';
  }

  const markdown = turndown
    .turndown(articleHtml)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title: title.trim(), markdown };
}

/**
 * Fetch a URL and return its readable content as Markdown.
 *
 * T2e: Primary path is Jina Reader (r.jina.ai/<url>) which renders the
 * page server-side (handles SPAs that hydrate client-side, like
 * lmsys.org or openrouter.ai) and returns clean markdown directly. No
 * DOM parsing in the service worker, so the "document is not defined"
 * error class is uncoded.
 *
 * Fallback: if Jina is unreachable (rate-limit, network), try the local
 * linkedom + Readability path. Best-effort — works for static HTML
 * (blogs, docs) and fails on JS-only SPAs (which Jina handled fine).
 *
 * See auto-docs/browd-agent-evolution.md (Tier 2e).
 */
export async function webFetchMarkdown(input: {
  url: string;
  maxChars?: number;
}): Promise<WebFetchResult | WebFetchError> {
  const maxChars = input.maxChars ?? 3000;
  const url = input.url;

  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, errorType: 'auth_or_config', message: 'URL must be absolute http(s)', url };
  }

  // Primary: Jina Reader. Server-side render + extract.
  const jinaResult = await tryJinaReader(url, maxChars);
  if (jinaResult.ok) return jinaResult;

  // Fallback: local fetch + linkedom + Readability. Works for static HTML.
  return tryLocalExtract(url, maxChars);
}

async function tryJinaReader(url: string, maxChars: number): Promise<WebFetchResult | WebFetchError> {
  const endpoint = `https://r.jina.ai/${url}`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      credentials: 'omit',
      headers: { Accept: 'text/plain' },
    });
  } catch (err) {
    return {
      ok: false,
      errorType: 'transient',
      message: `jina-reader network: ${err instanceof Error ? err.message : String(err)}`,
      url,
    };
  }
  if (!response.ok) {
    const errorType: WebFetchError['errorType'] = response.status >= 500 ? 'transient' : 'auth_or_config';
    return {
      ok: false,
      errorType,
      message: `jina-reader HTTP ${response.status}`,
      url,
    };
  }
  let body: string;
  try {
    body = await response.text();
  } catch (err) {
    return {
      ok: false,
      errorType: 'transient',
      message: `jina-reader body: ${err instanceof Error ? err.message : String(err)}`,
      url,
    };
  }
  // Jina prepends "Title: ...\nURL Source: ...\nMarkdown Content:\n..."
  // Extract title heuristically; the body itself is already markdown.
  const titleMatch = body.match(/^Title:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : url;
  const contentStart = body.indexOf('Markdown Content:');
  const markdown = contentStart >= 0 ? body.slice(contentStart + 'Markdown Content:'.length).trim() : body.trim();
  const { text, truncated } = truncate(markdown, maxChars);
  return { ok: true, url, title, markdown: text, truncated };
}

async function tryLocalExtract(url: string, maxChars: number): Promise<WebFetchResult | WebFetchError> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'follow',
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
  } catch (err) {
    return {
      ok: false,
      errorType: 'transient',
      message: `local network: ${err instanceof Error ? err.message : String(err)}`,
      url,
    };
  }

  if (!response.ok) {
    const errorType: WebFetchError['errorType'] = response.status >= 500 ? 'transient' : 'auth_or_config';
    return {
      ok: false,
      errorType,
      message: `HTTP ${response.status} ${response.statusText}`,
      url,
    };
  }

  let html: string;
  try {
    html = await response.text();
  } catch (err) {
    return {
      ok: false,
      errorType: 'transient',
      message: `read body failed: ${err instanceof Error ? err.message : String(err)}`,
      url,
    };
  }

  let title: string;
  let markdown: string;
  try {
    ({ title, markdown } = htmlToMarkdown(html, url));
  } catch (err) {
    logger.warning('htmlToMarkdown failed', err);
    return {
      ok: false,
      errorType: 'parse_failed',
      message: err instanceof Error ? err.message : String(err),
      url,
    };
  }

  const { text, truncated } = truncate(markdown, maxChars);
  return { ok: true, url, title, markdown: text, truncated };
}

/**
 * Search the web and return up to topK {title, url, snippet} hits.
 * Falls back DuckDuckGo → Bing if the primary fails.
 */
export async function webSearch(input: { query: string; topK?: number }): Promise<WebSearchResult | WebSearchError> {
  const topK = input.topK ?? 5;
  const query = input.query.trim();
  if (!query) {
    return { ok: false, errorType: 'parse_failed', message: 'empty query' };
  }

  const ddg = await tryDuckDuckGo(query, topK);
  if (ddg.ok) return ddg;

  const bing = await tryBing(query, topK);
  if (bing.ok) return bing;

  return { ok: false, errorType: 'transient', message: `both engines failed: ${ddg.message} | ${bing.message}` };
}

async function tryDuckDuckGo(query: string, topK: number): Promise<WebSearchResult | WebSearchError> {
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    // No custom User-Agent — DDG html anti-bot blocks unrecognised UA strings.
    // Service worker default UA is the browser's, which DDG accepts.
    const response = await fetch(endpoint, {
      method: 'GET',
      credentials: 'omit',
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) {
      return { ok: false, errorType: 'transient', message: `DDG HTTP ${response.status}` };
    }
    const html = await response.text();
    const results = parseDuckDuckGoHtml(html, topK);
    if (results.length === 0) {
      return { ok: false, errorType: 'parse_failed', message: 'DDG: no results parsed' };
    }
    return { ok: true, engine: 'duckduckgo', results };
  } catch (err) {
    return { ok: false, errorType: 'transient', message: `DDG: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function parseDuckDuckGoHtml(html: string, topK: number): WebSearchHit[] {
  const { document: doc } = parseHTML(html);
  const out: WebSearchHit[] = [];
  // DuckDuckGo HTML markup uses .result blocks with .result__title > a and .result__snippet.
  const blocks = doc.querySelectorAll('.result, .web-result');
  for (const block of Array.from(blocks)) {
    const link = block.querySelector('.result__a, .result__title a, a.result__a') as HTMLAnchorElement | null;
    const snippetEl = block.querySelector('.result__snippet') as HTMLElement | null;
    if (!link) continue;
    const rawHref = link.getAttribute('href') ?? '';
    // DDG sometimes wraps URLs in /l/?uddg=...&kh=...
    let url = rawHref;
    try {
      const u = new URL(rawHref, 'https://duckduckgo.com');
      const wrapped = u.searchParams.get('uddg');
      if (wrapped) url = decodeURIComponent(wrapped);
      else url = u.toString();
    } catch {
      // keep rawHref
    }
    out.push({
      title: (link.textContent ?? '').trim(),
      url,
      snippet: (snippetEl?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    });
    if (out.length >= topK) break;
  }
  return out;
}

async function tryBing(query: string, topK: number): Promise<WebSearchResult | WebSearchError> {
  const endpoint = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  try {
    // Same rationale as DDG — let Bing see the browser's default UA.
    const response = await fetch(endpoint, {
      method: 'GET',
      credentials: 'omit',
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) {
      return { ok: false, errorType: 'transient', message: `Bing HTTP ${response.status}` };
    }
    const html = await response.text();
    const results = parseBingHtml(html, topK);
    if (results.length === 0) {
      return { ok: false, errorType: 'parse_failed', message: 'Bing: no results parsed' };
    }
    return { ok: true, engine: 'bing', results };
  } catch (err) {
    return { ok: false, errorType: 'transient', message: `Bing: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function parseBingHtml(html: string, topK: number): WebSearchHit[] {
  const { document: doc } = parseHTML(html);
  const out: WebSearchHit[] = [];
  // Bing organic results live in li.b_algo with h2 > a and .b_caption p.
  const items = doc.querySelectorAll('li.b_algo');
  for (const item of Array.from(items)) {
    const link = item.querySelector('h2 a') as HTMLAnchorElement | null;
    const captionP = item.querySelector('.b_caption p') as HTMLElement | null;
    if (!link) continue;
    out.push({
      title: (link.textContent ?? '').trim(),
      url: link.href,
      snippet: (captionP?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    });
    if (out.length >= topK) break;
  }
  return out;
}

/**
 * Extract the currently-active tab's main content as Markdown via content
 * script injection. The page must be open and accessible.
 */
export async function extractActiveTabAsMarkdown(input: {
  maxChars?: number;
}): Promise<WebFetchResult | WebFetchError> {
  const maxChars = input.maxChars ?? 3000;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id || !tab.url) {
    return { ok: false, errorType: 'auth_or_config', message: 'no active tab', url: '' };
  }
  if (!/^https?:/i.test(tab.url)) {
    return { ok: false, errorType: 'auth_or_config', message: 'active tab is not http(s)', url: tab.url };
  }

  // T2f-final-fix-8: Readability/Turndown still touch global document
  // in some code paths under MV3 SW (gmail, docs.google.com, dynamic
  // SPAs). The "parse_failed: document is not defined" error in the
  // 2026-05-02 gmail trace is from that. Switch the primary
  // extraction strategy to "run innerText in the page context via
  // chrome.scripting.executeScript", which never crosses the SW
  // boundary for DOM access. Fall back to the local linkedom +
  // Readability + Turndown path only when innerText is too short
  // (i.e. heavy SPAs that render late).
  let pageTitle = '';
  let pageText = '';
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const safeText = (() => {
          // Prefer the visible content of the current view (innerText
          // respects display:none, which is what readers want).
          const main =
            (document.querySelector('main') as HTMLElement | null) ??
            (document.querySelector('article') as HTMLElement | null) ??
            document.body;
          return main?.innerText ?? document.body?.innerText ?? '';
        })();
        return { title: document.title, text: safeText };
      },
    });
    pageTitle = String(result?.title ?? '');
    pageText = String(result?.text ?? '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch (err) {
    return {
      ok: false,
      errorType: 'transient',
      message: `script injection failed: ${err instanceof Error ? err.message : String(err)}`,
      url: tab.url,
    };
  }

  if (pageText.length >= 200) {
    const { text, truncated } = truncate(pageText, maxChars);
    return { ok: true, url: tab.url, title: pageTitle || tab.url, markdown: text, truncated };
  }

  // Fallback: full outerHTML → linkedom → Readability → Turndown for
  // pages where innerText returned almost nothing (rare but happens
  // on heavily-virtualised SPAs). Wrapped in try so the
  // "document is not defined" error surfaces as a soft fallback,
  // not an agent-killing throw.
  try {
    const [{ result: htmlResult }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.documentElement.outerHTML,
    });
    const html = String(htmlResult ?? '');
    if (!html) {
      // Worst case — return whatever innerText we had, even if short.
      const { text, truncated } = truncate(pageText, maxChars);
      return { ok: true, url: tab.url, title: pageTitle || tab.url, markdown: text, truncated };
    }
    const { title, markdown } = htmlToMarkdown(html, tab.url);
    const { text, truncated } = truncate(markdown, maxChars);
    return { ok: true, url: tab.url, title: title || pageTitle || tab.url, markdown: text, truncated };
  } catch (err) {
    // Innerhtml fallback failed too — return the short innerText we
    // had instead of an error. Better partial than empty.
    logger.warning('htmlToMarkdown fallback failed; returning short innerText', err);
    const { text, truncated } = truncate(pageText || `(empty page on ${tab.url})`, maxChars);
    return { ok: true, url: tab.url, title: pageTitle || tab.url, markdown: text, truncated };
  }
}
