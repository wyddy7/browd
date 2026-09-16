// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractActiveTabAsMarkdown, webFetchMarkdown } from '../webTools';

// Resolve the same distribution Vite bundles for MV3, not Turndown's Node
// distribution (which silently provides its own DOM and hides this defect).
vi.mock('turndown', async () => {
  // @ts-expect-error upstream browser distribution has no separate declaration
  return await import('turndown/lib/turndown.browser.es.js');
});

afterEach(() => vi.unstubAllGlobals());

describe('Markdown in a DOM-less MV3 worker', () => {
  it('converts HTML without DOM globals and resolves relative links', async () => {
    expect(typeof document).toBe('undefined');
    expect(typeof DOMParser).toBe('undefined');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => ({
        ok: !url.includes('r.jina.ai'),
        status: url.includes('r.jina.ai') ? 503 : 200,
        text: async () =>
          '<html><head><title>Example</title></head><body><h1>Example</h1><a href="../help">Learn more</a></body></html>',
      })),
    );
    const result = await webFetchMarkdown({ url: 'https://example.test/docs/page' });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.markdown).toContain('[Learn more](https://example.test/help)');
  });

  it.each([40, 240])('preserves visible links with %i characters of page text', async length => {
    vi.stubGlobal('chrome', {
      tabs: { query: vi.fn(async () => [{ id: 7, url: 'https://example.test/' }]) },
      scripting: {
        executeScript: vi.fn(async () => [
          {
            result: {
              title: 'Example',
              text: 'x'.repeat(length),
              links: [{ text: 'Learn more', href: 'https://example.test/help' }],
            },
          },
        ]),
      },
    });
    const result = await extractActiveTabAsMarkdown({ maxChars: 3000 });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.markdown).toContain('[Learn more](https://example.test/help)');
  });
});
