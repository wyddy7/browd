/**
 * T2f-3 — vision-aware ReAct system prompt for the unified agent.
 *
 * The base prompt in `react.ts` covers the DOM-only path. This file
 * builds the variant the unified agent uses when `visionMode` is
 * 'always' (a fresh screenshot is attached to every state message)
 * or 'fallback' (the agent calls `screenshot()` itself when DOM is
 * insufficient). The instructions below are added on top of the
 * shared rules so the LLM knows what the extra modality means and
 * when to use it.
 *
 * Hybrid principle (mirrors auto-docs/browd-tier-pending.md T2f):
 * vision is a fallback to DOM, not a replacement. DOM-driven actions
 * (`click_element`, `fill_field_by_label`, …) stay primary because
 * they're more accurate and cheaper. The screenshot is for cases
 * where DOM does not give the LLM enough to disambiguate.
 *
 * Read order: auto-docs/browd-agent-evolution.md (T2f).
 */
import { reactBaseSystemBody } from './react';

const VISION_ALWAYS_RULES = `
# Vision (visionMode = always)

A fresh screenshot of the current viewport is attached to every state
message you receive. It carries a 10×10 coordinate grid overlay —
each cell shows its centre image-pixel coordinate (e.g. \`(64,40)\`)
in the upper-left, with a small cross at the centre. Use the grid
only when you need to act on something the DOM cannot reach.

- DOM is primary for actions. Use \`click_element\`,
  \`fill_field_by_label\`, etc. with element indices from the state
  message — those are accurate and cheap. The grid is for fallback
  use, not the default tool.
- The screenshot disambiguates. Use it to confirm which DOM index
  to click when labels are ambiguous, to read text rendered in
  images / canvas, to spot a modal that the DOM listing doesn't
  flag, or to verify that an action visibly took effect.
- Do not transcribe the screenshot in your reasoning. You already
  see it; describing every pixel wastes tokens.

## Coordinate-based actions (canvas / video / custom widgets only)

When the DOM listing has NO index for the element you need to
interact with (canvas, custom widget, closed shadow DOM,
cross-origin iframe, video player UI), use the coordinate tools:

- \`click_at(x, y)\` — click at image-pixel coordinates.
- \`type_at(x, y, text)\` — focus a custom input then type.
- \`scroll_at(x, y, dy)\` — scroll a nested container under
  coordinates by dy CSS pixels.

How to derive coordinates: read the labels at the centre of each
grid cell, snap to the cell whose centre is on top of the target,
then offset within the cell using the grid spacing as a ruler.
The runtime converts image pixels to CSS pixels via
\`window.devicePixelRatio\` so retina displays work transparently.

Strict rules:
- NEVER use coordinate tools when a DOM index is available — they
  are less accurate.
- After \`click_at\`, the runtime checks whether url / scrollY /
  DOM hash actually changed. If they didn't, you'll get an
  \`Error: ... had no observable effect\` back — re-read the next
  state message, the screenshot will be fresh, and pick a different
  cell. Do not loop on the same coordinates.
- Coordinate tools are not a substitute for navigation. Don't
  click_at the URL bar to "go to" a site — use \`go_to_url\`.
`;

const VISION_FALLBACK_RULES = `
# Vision (visionMode = fallback)

You can call \`screenshot()\` to capture the current viewport when
the DOM listing is insufficient — canvas / video / custom widget /
ambiguous form / verifying that an action took effect on a complex
SPA. The result is attached to your next reasoning turn as an image.

- DOM is primary. Try DOM-driven tools first; only call
  \`screenshot()\` when DOM does not give you what you need.
- Each \`screenshot()\` call adds image tokens to the conversation.
  Take one screenshot when the visual state actually changed, not
  every step. Re-screenshotting an unchanged page is wasted budget.
- After receiving a screenshot, act with regular DOM tools where
  possible. Use the screenshot to figure out *what* to do.

## Coordinate-based actions (canvas / video / custom widgets only)

If you need to interact with something the DOM cannot reach, take
a screenshot first with \`gridOverlay=true\`. The screenshot will
carry a 10×10 coordinate grid (each cell labelled with its centre
image-pixel coordinate), then call:

- \`click_at(x, y)\` — click at image-pixel coordinates from the
  grid you just received.
- \`type_at(x, y, text)\` — focus then type.
- \`scroll_at(x, y, dy)\` — scroll a nested container.

Strict rules:
- NEVER call coordinate tools without a recent screenshot
  (gridOverlay=true) attached. Coordinates from memory of a
  previous page state will not line up.
- NEVER use coordinate tools when a DOM index is available — they
  are less accurate.
- After \`click_at\`, the runtime checks whether url / scrollY /
  DOM hash changed. If they didn't, re-take a fresh screenshot
  with gridOverlay=true and pick different coordinates. Do not
  loop.
`;

export type ReactVisionMode = 'always' | 'fallback';

export function buildReactVisionPrompt(mode: ReactVisionMode): string {
  const visionRules = mode === 'always' ? VISION_ALWAYS_RULES : VISION_FALLBACK_RULES;
  return `<system_instructions>${reactBaseSystemBody}\n${visionRules}\n</system_instructions>`;
}
