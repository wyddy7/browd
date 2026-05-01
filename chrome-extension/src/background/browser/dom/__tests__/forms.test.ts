import { describe, it, expect } from 'vitest';
import { DOMElementNode, DOMTextNode, type DOMState } from '../views';
import { extractForms, formatFormsForPrompt } from '../forms';

/** Helper to build a minimal DOMElementNode */
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

function makeDomState(root: DOMElementNode): DOMState {
  return { elementTree: root, selectorMap: new Map() };
}

describe('extractForms', () => {
  it('returns empty array when no form fields present', () => {
    const root = el('body', {}, [el('div', {}, [txt('Hello world')])]);
    expect(extractForms(makeDomState(root))).toHaveLength(0);
  });

  it('extracts field with explicit <label for="id">', () => {
    const input = el('input', { id: 'email', type: 'email' }, [], {
      interactive: true,
      highlightIndex: 1,
      xpath: '//input[@id="email"]',
    });
    const label = el('label', { for: 'email' }, [txt('Email address')]);
    const root = el('body', {}, [label, input]);

    const forms = extractForms(makeDomState(root));
    expect(forms).toHaveLength(1);
    const field = forms[0].fields[0];
    expect(field.label).toBe('Email address');
    expect(field.labelSource).toBe('label_for');
    expect(field.type).toBe('email');
  });

  it('extracts field with aria-label when no <label for> exists', () => {
    const textarea = el('textarea', { 'aria-label': 'Cover letter' }, [], {
      interactive: true,
      highlightIndex: 2,
      xpath: '//textarea[1]',
    });
    const root = el('body', {}, [textarea]);

    const forms = extractForms(makeDomState(root));
    const field = forms[0].fields[0];
    expect(field.label).toBe('Cover letter');
    expect(field.labelSource).toBe('aria_label');
    expect(field.type).toBe('textarea');
  });

  it('extracts field label from preceding sibling text (hh.ru-style)', () => {
    // Structure: div > [span("Английский язык"), textarea]
    const labelSpan = el('span', {}, [txt('Английский язык')]);
    const textarea1 = el('textarea', {}, [], { interactive: true, highlightIndex: 5, xpath: '//textarea[1]' });
    const labelSpan2 = el('span', {}, [txt('Вредные привычки')]);
    const textarea2 = el('textarea', {}, [], { interactive: true, highlightIndex: 7, xpath: '//textarea[2]' });
    const form = el('form', {}, [labelSpan, textarea1, labelSpan2, textarea2]);
    const root = el('body', {}, [form]);

    const forms = extractForms(makeDomState(root));
    expect(forms).toHaveLength(1);
    expect(forms[0].fields).toHaveLength(2);
    expect(forms[0].fields[0].label).toBe('Английский язык');
    expect(forms[0].fields[1].label).toBe('Вредные привычки');
    // Crucially: different labels for different textareas
    expect(forms[0].fields[0].label).not.toBe(forms[0].fields[1].label);
  });

  it('marks field as required when required attribute present', () => {
    const input = el('input', { id: 'phone', required: '' }, [], { interactive: true, highlightIndex: 3 });
    const label = el('label', { for: 'phone' }, [txt('Phone')]);
    const root = el('body', {}, [label, input]);

    const forms = extractForms(makeDomState(root));
    expect(forms[0].fields[0].required).toBe(true);
  });

  it('detects submit button and includes in form', () => {
    const input = el('input', { id: 'name', type: 'text' }, [], { interactive: true, highlightIndex: 1 });
    const label = el('label', { for: 'name' }, [txt('Name')]);
    const submit = el('button', { type: 'submit' }, [txt('Send')], { xpath: '//button[1]' });
    const root = el('body', {}, [label, input, submit]);

    const forms = extractForms(makeDomState(root));
    expect(forms[0].submitButtons).toHaveLength(1);
    expect(forms[0].submitButtons[0].label).toBe('Send');
  });
});

describe('formatFormsForPrompt', () => {
  it('returns empty string when no forms', () => {
    expect(formatFormsForPrompt([])).toBe('');
  });

  it('includes field labels and types', () => {
    const forms = [
      {
        fields: [
          {
            label: 'Email',
            type: 'email' as const,
            value: '',
            required: true,
            xpathCandidates: [],
            highlightIndex: 1,
            labelSource: 'label_for' as const,
          },
          {
            label: 'Message',
            type: 'textarea' as const,
            value: '',
            required: false,
            xpathCandidates: [],
            highlightIndex: 2,
            labelSource: 'aria_label' as const,
          },
        ],
        submitButtons: [{ label: 'Send', xpath: null, highlightIndex: null }],
        containerXpath: null,
      },
    ];

    const output = formatFormsForPrompt(forms);
    expect(output).toContain('## Forms detected');
    expect(output).toContain('"Email"');
    expect(output).toContain('"Message"');
    expect(output).toContain('*required');
    expect(output).toContain('[email]');
    expect(output).toContain('[textarea]');
  });
});
