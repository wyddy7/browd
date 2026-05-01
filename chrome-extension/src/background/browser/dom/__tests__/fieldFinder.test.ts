import { describe, it, expect } from 'vitest';
import { DOMElementNode, DOMTextNode, type DOMState } from '../views';
import { findFieldByLabel } from '../fieldFinder';

function el(
  tagName: string,
  attrs: Record<string, string> = {},
  children: (DOMElementNode | DOMTextNode)[] = [],
  opts: { interactive?: boolean; highlightIndex?: number; xpath?: string } = {},
): DOMElementNode {
  const node = new DOMElementNode({
    tagName,
    xpath: opts.xpath ?? `/${tagName}`,
    attributes: attrs,
    children: [],
    isVisible: true,
    isInteractive: opts.interactive ?? false,
    isTopElement: true,
    isInViewport: true,
    highlightIndex: opts.highlightIndex ?? null,
  });
  for (const child of children) {
    child.parent = node;
    node.children.push(child);
  }
  return node;
}

function txt(text: string): DOMTextNode {
  return new DOMTextNode(text, true, null);
}
function state(root: DOMElementNode): DOMState {
  return { elementTree: root, selectorMap: new Map() };
}

describe('findFieldByLabel', () => {
  it('finds field by exact <label for="id"> match', () => {
    const input = el('input', { id: 'email', type: 'text' }, [], {
      interactive: true,
      highlightIndex: 1,
      xpath: '//input[@id="email"]',
    });
    const label = el('label', { for: 'email' }, [txt('Email address')]);
    const root = el('body', {}, [label, input]);

    const found = findFieldByLabel(state(root), 'Email address');
    expect(found).toBe(input);
  });

  it('finds field by partial label match (case-insensitive)', () => {
    const input = el('input', { id: 'name' }, [], { interactive: true, highlightIndex: 2 });
    const label = el('label', { for: 'name' }, [txt('Full Name')]);
    const root = el('body', {}, [label, input]);

    const found = findFieldByLabel(state(root), 'full name');
    expect(found).toBe(input);
  });

  it('finds field by aria-label', () => {
    const textarea = el('textarea', { 'aria-label': 'Cover letter text' }, [], {
      interactive: true,
      highlightIndex: 3,
    });
    const root = el('body', {}, [textarea]);

    const found = findFieldByLabel(state(root), 'Cover letter text');
    expect(found).toBe(textarea);
  });

  it('finds field by placeholder fallback', () => {
    const input = el('input', { placeholder: 'Enter your phone number' }, [], { interactive: true, highlightIndex: 4 });
    const root = el('body', {}, [input]);

    const found = findFieldByLabel(state(root), 'Enter your phone number');
    expect(found).toBe(input);
  });

  it('nth=2 returns the second matching field', () => {
    // Two textareas with sibling text labels
    const span1 = el('span', {}, [txt('Английский язык')]);
    const ta1 = el('textarea', {}, [], { interactive: true, highlightIndex: 5, xpath: '//textarea[1]' });
    const span2 = el('span', {}, [txt('Вредные привычки')]);
    const ta2 = el('textarea', {}, [], { interactive: true, highlightIndex: 7, xpath: '//textarea[2]' });
    // Both would partially match "язык" but let's test exact nth
    const span3 = el('span', {}, [txt('Другой текст')]);
    const ta3 = el('textarea', {}, [], { interactive: true, highlightIndex: 9, xpath: '//textarea[3]' });
    const root = el('body', {}, [span1, ta1, span2, ta2, span3, ta3]);

    // "Английский" → should find ta1 first
    const found1 = findFieldByLabel(state(root), 'Английский язык', 1);
    expect(found1).toBe(ta1);

    // "Вредные привычки" → should find ta2
    const found2 = findFieldByLabel(state(root), 'Вредные привычки', 1);
    expect(found2).toBe(ta2);
  });

  it('returns null when no match found', () => {
    const input = el('input', { 'aria-label': 'Username' }, [], { interactive: true, highlightIndex: 1 });
    const root = el('body', {}, [input]);

    const found = findFieldByLabel(state(root), 'Nonexistent field label xyz');
    expect(found).toBeNull();
  });
});
