import { DOMElementNode, DOMTextNode, type DOMBaseNode } from './views';
import type { DOMState } from './views';

export type FormFieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'radio'
  | 'checkbox'
  | 'email'
  | 'tel'
  | 'number'
  | 'password'
  | 'unknown';

export interface FormField {
  /** Resolved human-readable label (from <label>, aria-label, placeholder, or sibling text). */
  label: string;
  type: FormFieldType;
  value: string;
  required: boolean;
  /** XPath candidates for finding this field, ordered by priority. */
  xpathCandidates: string[];
  /** The highlight index for fallback index-based interaction. */
  highlightIndex: number | null;
  /** Raw attribute sources used to derive the label (for debug). */
  labelSource: 'label_for' | 'aria_label' | 'placeholder' | 'sibling_text' | 'ancestor_label' | 'title' | 'none';
}

export interface FormModel {
  /** Inferred form title from a legend, heading, or container label. */
  title?: string;
  fields: FormField[];
  submitButtons: Array<{ label: string; xpath: string | null; highlightIndex: number | null }>;
  containerXpath: string | null;
}

const INPUT_TAGS = new Set(['input', 'textarea', 'select']);
const SUBMIT_TAGS = new Set(['button', 'input']);

/** Collect all text from a node and its descendants. */
function collectText(node: DOMBaseNode): string {
  if (node instanceof DOMTextNode) return node.text.trim();
  if (node instanceof DOMElementNode) {
    return node.children.map(collectText).join(' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

/** Get attribute value case-insensitively. */
function attr(node: DOMElementNode, name: string): string {
  return node.attributes[name] ?? node.attributes[name.toLowerCase()] ?? '';
}

/** Determine field type from tagName + type attribute. */
function resolveFieldType(node: DOMElementNode): FormFieldType {
  const tag = (node.tagName ?? '').toLowerCase();
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'input') {
    const t = (attr(node, 'type') || 'text').toLowerCase();
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (t === 'email') return 'email';
    if (t === 'tel') return 'tel';
    if (t === 'number') return 'number';
    if (t === 'password') return 'password';
    if (t === 'submit' || t === 'button') return 'unknown'; // not a data field
    return 'text';
  }
  return 'unknown';
}

/** Walk up the DOM tree to find the nearest ancestor with a given tagName. */
function findAncestor(node: DOMElementNode, tagName: string): DOMElementNode | null {
  let current: DOMElementNode | null = node.parent;
  while (current) {
    if ((current.tagName ?? '').toLowerCase() === tagName) return current;
    current = current.parent;
  }
  return null;
}

/**
 * Find the <label> element whose `for` attribute matches the given id.
 * Scans entire tree from root.
 */
function findLabelForId(root: DOMElementNode, id: string): DOMElementNode | null {
  if (!id) return null;

  function walk(node: DOMBaseNode): DOMElementNode | null {
    if (!(node instanceof DOMElementNode)) return null;
    if ((node.tagName ?? '').toLowerCase() === 'label') {
      const forAttr = attr(node, 'for') || attr(node, 'htmlFor');
      if (forAttr === id) return node;
    }
    for (const child of node.children) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  }

  return walk(root);
}

/**
 * Try to resolve a human-readable label for a form field element.
 * Priority: <label for=id> → aria-label → ancestor <label> → preceding sibling text → placeholder → title
 */
function resolveLabel(node: DOMElementNode, root: DOMElementNode): { label: string; source: FormField['labelSource'] } {
  // 1. <label for="id">
  const id = attr(node, 'id');
  if (id) {
    const labelEl = findLabelForId(root, id);
    if (labelEl) {
      const text = collectText(labelEl).trim();
      if (text) return { label: text, source: 'label_for' };
    }
  }

  // 2. aria-label
  const ariaLabel = attr(node, 'aria-label');
  if (ariaLabel) return { label: ariaLabel.trim(), source: 'aria_label' };

  // 3. Ancestor <label> (input wrapped inside label)
  const ancestorLabel = findAncestor(node, 'label');
  if (ancestorLabel) {
    const text = collectText(ancestorLabel).trim();
    if (text) return { label: text, source: 'ancestor_label' };
  }

  // 4. Preceding sibling text — walk parent's children before this node
  if (node.parent) {
    const siblings = node.parent.children;
    const idx = siblings.indexOf(node);
    for (let i = idx - 1; i >= 0; i--) {
      const sib = siblings[i];
      const text = collectText(sib).trim();
      if (text && text.length < 120) {
        return { label: text, source: 'sibling_text' };
      }
    }
  }

  // 5. placeholder / title
  const placeholder = attr(node, 'placeholder');
  if (placeholder) return { label: placeholder.trim(), source: 'placeholder' };
  const title = attr(node, 'title');
  if (title) return { label: title.trim(), source: 'title' };

  return { label: '', source: 'none' };
}

/** Check if a button/input[type=submit] is a submit button. */
function isSubmitButton(node: DOMElementNode): boolean {
  const tag = (node.tagName ?? '').toLowerCase();
  if (tag === 'button') {
    const btnType = (attr(node, 'type') || 'submit').toLowerCase();
    return btnType === 'submit' || btnType === 'button';
  }
  if (tag === 'input') {
    const inputType = (attr(node, 'type') || '').toLowerCase();
    return inputType === 'submit';
  }
  // div/span acting as button (role="button")
  if (attr(node, 'role') === 'button' || attr(node, 'role') === 'submit') return true;
  return false;
}

/**
 * Walk the DOM tree and collect all interactive form fields.
 * Returns flat list of (node, label) pairs; caller groups them into FormModels.
 */
function collectFieldNodes(
  root: DOMElementNode,
): Array<{ node: DOMElementNode; label: string; labelSource: FormField['labelSource'] }> {
  const results: Array<{ node: DOMElementNode; label: string; labelSource: FormField['labelSource'] }> = [];

  function walk(node: DOMBaseNode): void {
    if (!(node instanceof DOMElementNode)) return;
    const tag = (node.tagName ?? '').toLowerCase();

    if (INPUT_TAGS.has(tag) && node.isInteractive) {
      const fieldType = resolveFieldType(node);
      // Skip submit inputs and hidden fields
      if (fieldType !== 'unknown') {
        const { label, source } = resolveLabel(node, root);
        results.push({ node, label, labelSource: source });
      }
    }

    for (const child of node.children) {
      walk(child);
    }
  }

  walk(root);
  return results;
}

/** Collect submit buttons from the tree. */
function collectSubmitButtons(root: DOMElementNode): FormModel['submitButtons'] {
  const results: FormModel['submitButtons'] = [];

  function walk(node: DOMBaseNode): void {
    if (!(node instanceof DOMElementNode)) return;
    if (SUBMIT_TAGS.has((node.tagName ?? '').toLowerCase()) && isSubmitButton(node)) {
      const label = collectText(node).trim() || attr(node, 'value') || attr(node, 'aria-label') || 'Submit';
      results.push({ label, xpath: node.xpath, highlightIndex: node.highlightIndex });
    }
    for (const child of node.children) walk(child);
  }

  walk(root);
  return results;
}

/**
 * Extract structured form models from a DOMState.
 *
 * Groups fields by their nearest <form> ancestor. If no <form> ancestor is found,
 * all ungrouped fields are placed in a single synthetic form.
 */
export function extractForms(domState: DOMState): FormModel[] {
  const root = domState.elementTree;
  const fieldNodes = collectFieldNodes(root);
  if (fieldNodes.length === 0) return [];

  // Group by nearest <form> ancestor xpath (null = no form ancestor)
  const groups = new Map<string | null, typeof fieldNodes>();
  for (const item of fieldNodes) {
    const formAncestor = findAncestor(item.node, 'form');
    const key = formAncestor?.xpath ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }

  const submitButtons = collectSubmitButtons(root);
  const forms: FormModel[] = [];

  for (const [containerXpath, items] of groups) {
    const fields: FormField[] = items.map(({ node, label, labelSource }) => ({
      label: label || `field_${node.highlightIndex ?? 'unknown'}`,
      type: resolveFieldType(node),
      value: attr(node, 'value') || '',
      required:
        attr(node, 'required') === 'true' || attr(node, 'required') === '' || attr(node, 'aria-required') === 'true',
      xpathCandidates: node.xpath ? [node.xpath] : [],
      highlightIndex: node.highlightIndex,
      labelSource,
    }));

    forms.push({
      fields,
      submitButtons,
      containerXpath,
    });
  }

  return forms;
}

/** Format forms as a concise section for inclusion in the navigator state prompt. */
export function formatFormsForPrompt(forms: FormModel[]): string {
  if (forms.length === 0) return '';

  const lines: string[] = ['## Forms detected'];
  forms.forEach((form, fi) => {
    const requiredCount = form.fields.filter(f => f.required).length;
    const submitLabel = form.submitButtons[0]?.label ?? 'Submit';
    lines.push(`Form ${fi + 1} (${form.fields.length} fields, ${requiredCount} required, submit: "${submitLabel}"):`);
    form.fields.forEach(field => {
      const req = field.required ? ' *required' : '';
      const val = field.value ? ` = "${field.value}"` : '';
      lines.push(`  [${field.type}] "${field.label}"${val}${req}`);
    });
  });

  return lines.join('\n');
}
