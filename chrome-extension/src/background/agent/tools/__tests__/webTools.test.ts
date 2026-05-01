// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { webFetchMarkdown, webSearch } from '../webTools';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

const originalFetch = globalThis.fetch;

function mockFetchOnce(html: string, status = 200): void {
  globalThis.fetch = vi.fn(async () => {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Err',
      text: async () => html,
    } as Response;
  }) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('webFetchMarkdown', () => {
  it('rejects relative URLs', async () => {
    const result = await webFetchMarkdown({ url: '/relative' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorType).toBe('auth_or_config');
  });

  it('classifies 5xx as transient and 4xx as auth_or_config', async () => {
    mockFetchOnce('', 500);
    const r1 = await webFetchMarkdown({ url: 'https://example.com' });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errorType).toBe('transient');

    mockFetchOnce('', 404);
    const r2 = await webFetchMarkdown({ url: 'https://example.com/missing' });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errorType).toBe('auth_or_config');
  });

  it('extracts a readable article and converts to markdown', async () => {
    const html = `<!doctype html><html><head><title>Sample</title></head><body>
      <header>nav junk</header>
      <main><article>
        <h1>Hello World</h1>
        <p>This is a long paragraph with enough content for Readability to score it as the main article body. It mentions things and explains them clearly so the score is high enough to qualify.</p>
        <p>Second paragraph also adds substance to make the score even higher and ensures Readability commits to picking this branch as the article.</p>
      </article></main>
      <footer>copyright</footer>
    </body></html>`;
    mockFetchOnce(html);
    const result = await webFetchMarkdown({ url: 'https://example.com/post' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Readability may fall back to <title> in happy-dom; both are acceptable.
      expect(result.title.toLowerCase()).toMatch(/hello|sample/);
      expect(result.markdown).toContain('Hello World');
      expect(result.markdown).not.toContain('nav junk');
      expect(result.markdown).not.toContain('copyright');
    }
  });

  it('truncates long markdown and reports truncated flag', async () => {
    const longBody = '<p>' + 'word '.repeat(2000) + '</p>';
    const html = `<html><body><main>${longBody}</main></body></html>`;
    mockFetchOnce(html);
    const result = await webFetchMarkdown({ url: 'https://example.com/long', maxChars: 800 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.truncated).toBe(true);
      expect(result.markdown.length).toBeLessThanOrEqual(900);
      expect(result.markdown).toContain('truncated');
    }
  });
});

describe('webSearch (DuckDuckGo parsing)', () => {
  it('parses DDG result blocks and unwraps the redirect URL', async () => {
    const ddg = `<html><body>
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone">First Result Title</a>
        <a class="result__snippet">First snippet text describing the result.</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.org/two">Second Result</a>
        <a class="result__snippet">Second snippet.</a>
      </div>
    </body></html>`;
    mockFetchOnce(ddg);
    const result = await webSearch({ query: 'best open-source llm', topK: 5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.engine).toBe('duckduckgo');
      expect(result.results).toHaveLength(2);
      expect(result.results[0].title).toBe('First Result Title');
      expect(result.results[0].url).toBe('https://example.com/one');
      expect(result.results[0].snippet).toContain('First snippet');
      expect(result.results[1].url).toBe('https://example.org/two');
    }
  });

  it('respects topK', async () => {
    const ddg =
      '<html><body>' +
      Array.from(
        { length: 8 },
        (_, i) => `<div class="result"><a class="result__a" href="https://e.com/${i}">T${i}</a></div>`,
      ).join('') +
      '</body></html>';
    mockFetchOnce(ddg);
    const result = await webSearch({ query: 'q', topK: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.results).toHaveLength(3);
  });

  it('falls back to Bing when DDG returns no results', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async (url: string) => {
      callCount++;
      const isDDG = url.includes('duckduckgo');
      const html = isDDG
        ? '<html><body>no results here</body></html>'
        : `<html><body><li class="b_algo"><h2><a href="https://example.com/x">Bing Title</a></h2><div class="b_caption"><p>Bing snippet here.</p></div></li></body></html>`;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => html,
      } as Response;
    }) as unknown as typeof fetch;
    const result = await webSearch({ query: 'x', topK: 1 });
    expect(callCount).toBe(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.engine).toBe('bing');
      expect(result.results[0].title).toBe('Bing Title');
      expect(result.results[0].url).toBe('https://example.com/x');
    }
  });

  it('returns transient error when both engines fail', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          text: async () => '',
        }) as Response,
    ) as unknown as typeof fetch;
    const result = await webSearch({ query: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorType).toBe('transient');
  });

  it('rejects empty query', async () => {
    const result = await webSearch({ query: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorType).toBe('parse_failed');
  });
});
