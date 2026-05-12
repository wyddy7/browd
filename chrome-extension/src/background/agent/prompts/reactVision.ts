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
# Vision (visionMode = always) — coordinates are your primary path

> THIS SECTION OVERRIDES the "For INTERACTIVE flows" rule in the
> base prompt. In always mode coordinate tools win by default.

A fresh screenshot of the current viewport is attached to every state
message you receive. It carries a 10×10 coordinate grid overlay —
each cell shows its centre image-pixel coordinate (e.g. \`(64,40)\`)
in the upper-left, with a small cross at the centre. The user
turned this mode on to act through pixels, not through DOM
indices. Treat coordinates as the primary interaction path.

## Default tools in this mode

Prefer the coordinate tools whenever you can pinpoint the target
visually:

- \`click_at(x, y, intent)\` — click at image-pixel coordinates.
- \`type_at(x, y, text, intent)\` — click first then type into the
  focused input.
- \`scroll_at(x, y, dy, intent)\` — scroll a nested container under
  coordinates by dy CSS pixels.

How to derive coordinates: find the cell whose centre is on top of
the target, read the centre coordinate from its upper-left label,
then offset within the cell using the grid spacing as a ruler.
The runtime converts image pixels to CSS pixels via
\`window.devicePixelRatio\` so retina displays work transparently.

## When DOM tools still help

DOM-driven tools (\`click_element\`, \`input_text\`,
\`fill_field_by_label\`) remain available as a backup. Use them
ONLY when:
- the Interactive-elements listing has a clear unambiguous index
  for a textual control (e.g. a labelled input field), AND
- the page has settled (no recent navigation in the previous step), AND
- coordinate targeting would be obviously fragile (tiny checkbox,
  dense menu).

If the Interactive-elements listing is empty or has \`(empty page)\`,
the DOM extraction failed for this step — DO NOT pick numeric
indices out of memory. Use \`click_at\` / \`type_at\` from the
screenshot instead.

## Failure handling — strict

If a DOM-driven tool returns
\`Error: Element with index N does not exist\` or
\`... had no observable effect\`, the DOM has shifted under you.
Switch to the coordinate tools on the very next step — re-read the
fresh screenshot in the next state message and act through
\`click_at\` / \`type_at\` / \`scroll_at\` instead. Do NOT retry the
same DOM index, do NOT pick a different DOM index from memory of
an earlier turn.

## Other rules

- Do not transcribe the screenshot in your reasoning. You see it;
  describing every pixel wastes tokens.
- After \`click_at\`, the runtime checks whether url / scrollY /
  DOM hash actually changed. If they didn't, you'll get an
  \`Error: ... had no observable effect\` back — pick a different
  cell on the next step. Do not loop on the same coordinates.
- Coordinate tools are not a substitute for navigation. Don't
  \`click_at\` the URL bar to "go to" a site — use \`go_to_url\`.
`;

const VISION_FALLBACK_RULES = `
# Vision (visionMode = fallback)

The runtime auto-attaches a screenshot whenever it detects you'll
likely need one — empty DOM listing after a navigation, repeated
"Element with index N does not exist" / "had no observable effect"
errors, or no capture for the last 5 steps. Otherwise state
messages stay text-only to keep cost low.

You can also call \`screenshot()\` explicitly when you want a
fresh frame for a reason the runtime can't detect (verifying a
visual change after a non-DOM action, comparing two states, etc.).
Use \`gridOverlay: true\` if you intend to call coordinate-based
actions next.

- DOM is primary. Try DOM-driven tools first; the auto-screenshot
  is for when DOM falls short.
- Each \`screenshot()\` call adds image tokens. The runtime's
  adaptive auto-capture already covers the common cases, so
  manual calls should be rare.
- After receiving a screenshot, act with regular DOM tools where
  possible. Use the image to figure out *what* to do.

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
