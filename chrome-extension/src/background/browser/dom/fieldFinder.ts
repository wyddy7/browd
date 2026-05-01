import type { DOMState } from './views';
import { DOMElementNode, DOMTextNode, type DOMBaseNode } from './views';

/**
 * Finds a form field element by its human-readable label.
 *
 * Priority chain (from highest to lowest):
 *   1. Exact label match via <label for="id">
 *   2. Exact aria-label match
 *   3. Exact placeholder match
 *   4. Exact preceding-sibling text match
 *   5. Partial (contains) match across all above, case-insensitive
 *   6. title attribute partial match
 *
 * Returns the nth match (1-indexed, default 1) to handle duplicate fields.
 */

const FIELD_TAGS = new Set(['input', 'textarea', 'select']);

interface CandidateField {
  node: DOMElementNode;
  matchScore: number; // higher = better match
}

function attr(node: DOMElementNode, name: string): string {
  return node.attributes[name] ?? '';
}

function collectText(node: DOMBaseNode): string {
  if (node instanceof DOMTextNode) return node.text.trim();
  if (node instanceof DOMElementNode) {
    return node.children.map(collectText).join(' ').replace(/\s+/g, ' ').trim();
  }
  return '';
}

function findLabelForId(root: DOMElementNode, id: string): string {
  if (!id) return '';
  function walk(node: DOMBaseNode): string {
    if (!(node instanceof DOMElementNode)) return '';
    if ((node.tagName ?? '').toLowerCase() === 'label') {
      if (attr(node, 'for') === id || attr(node, 'htmlFor') === id) {
        return collectText(node);
      }
    }
    for (const child of node.children) {
      const found = walk(child);
      if (found) return found;
    }
    return '';
  }
  return walk(root);
}

function findAncestorLabelText(node: DOMElementNode): string {
  let current: DOMElementNode | null = node.parent;
  while (current) {
    if ((current.tagName ?? '').toLowerCase() === 'label') {
      return collectText(current);
    }
    current = current.parent;
  }
  return '';
}

function findPrecedingSiblingText(node: DOMElementNode): string {
  if (!node.parent) return '';
  const siblings = node.parent.children;
  const idx = siblings.indexOf(node);
  for (let i = idx - 1; i >= 0; i--) {
    const text = collectText(siblings[i]).trim();
    if (text && text.length < 150) return text;
  }
  return '';
}

function isDataField(node: DOMElementNode): boolean {
  const tag = (node.tagName ?? '').toLowerCase();
  if (!FIELD_TAGS.has(tag)) return false;
  if (tag === 'input') {
    const t = (attr(node, 'type') || 'text').toLowerCase();
    if (t === 'submit' || t === 'button' || t === 'hidden' || t === 'image') return false;
  }
  return true;
}

function scoreMatch(candidate: string, query: string): number {
  if (!candidate) return 0;
  const c = candidate.toLowerCase().trim();
  const q = query.toLowerCase().trim();
  if (c === q) return 100; // exact
  if (c.startsWith(q)) return 80; // prefix
  if (c.includes(q)) return 60; // contains
  if (q.includes(c)) return 40; // query contains candidate (truncated label)
  return 0;
}

/**
 * Find a form field element in the DOM by label text.
 *
 * @param domState - Current DOM state
 * @param label - Human-readable label to search for
 * @param nth - 1-indexed match number (default 1 = first match)
 * @returns The matching DOMElementNode or null if not found
 */
export function findFieldByLabel(domState: DOMState, label: string, nth = 1): DOMElementNode | null {
  const root = domState.elementTree;
  const candidates: CandidateField[] = [];

  function walk(node: DOMBaseNode): void {
    if (!(node instanceof DOMElementNode)) return;

    if (isDataField(node)) {
      let bestScore = 0;

      const addScore = (candidate: string, bonus: number): void => {
        const s = scoreMatch(candidate, label);
        if (s > 0) bestScore = Math.max(bestScore, s + bonus);
      };

      // 1. <label for="id"> (highest priority)
      const id = attr(node, 'id');
      addScore(findLabelForId(root, id), 10);
      // 2. aria-label
      addScore(attr(node, 'aria-label'), 5);
      // 3. Ancestor label
      addScore(findAncestorLabelText(node), 3);
      // 4. Preceding sibling text
      addScore(findPrecedingSiblingText(node), 0);
      // 5. placeholder (lower priority)
      addScore(attr(node, 'placeholder'), -10);
      // 6. title
      addScore(attr(node, 'title'), -15);

      if (bestScore > 0) {
        candidates.push({ node, matchScore: bestScore });
      }
    }

    for (const child of node.children) walk(child);
  }

  walk(root);

  // Sort descending by score, then by document order (stable via original array order)
  candidates.sort((a, b) => b.matchScore - a.matchScore);

  const target = candidates[nth - 1];
  return target?.node ?? null;
}
