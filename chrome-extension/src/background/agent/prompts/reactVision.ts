/**
 * Vision-aware ReAct system prompt for the unified agent.
 *
 * The base prompt in `react.ts` covers the DOM-only path. This file
 * builds the variant the unified agent uses when `visionMode='on'`,
 * i.e. the LLM has access to the `screenshot()` tool plus coordinate
 * actions. The runtime never auto-attaches a screenshot — the model
 * decides when an image is worth the tokens, the same way browser-use,
 * Stagehand, OpenAI Operator and Anthropic computer-use let agents
 * drive their own perception loop.
 *
 * Hybrid principle: DOM tools stay primary. They are more accurate
 * and cheaper than pixel grounding. Screenshots are for when the
 * Interactive-elements listing is empty, just failed, or the page has
 * just navigated and the model wants to verify what actually rendered.
 */
import { reactBaseSystemBody } from './react';

const VISION_ON_RULES = `
# Vision (visionMode = on)

You have a \`screenshot()\` tool and three coordinate actions
(\`click_at\`, \`type_at\`, \`scroll_at\`) in addition to the standard
DOM-driven actions. State messages are text-only by default; an image
only enters the conversation when YOU call \`screenshot()\`. Decide
when that's worth the tokens.

## Default: DOM tools first

Prefer DOM-driven tools whenever the Interactive-elements listing
gives you a clear, unambiguous handle:

- \`click_element\` — when the element you want has a numeric index
  in the listing.
- \`input_text\` / \`fill_field_by_label\` — when you have an input
  field with a label or index.

DOM tools are cheaper, faster, and more accurate than coordinate
clicks on standard web UI. Use them as the default path.

## When to call \`screenshot()\`

Reach for the screenshot when DOM information is insufficient to
decide what to do. Concretely:

- The Interactive-elements listing is empty / shows \`(empty page)\`
  — DOM extraction failed for this step.
- A DOM-driven tool just returned
  \`Error: Element with index N does not exist\` or
  \`... had no observable effect\` — the DOM has shifted under you,
  the indices you remember are stale.
- The page just navigated (URL changed in the previous step) and you
  want to verify what actually rendered, especially before clicking
  anything.
- You're interacting with a non-DOM surface (canvas, video player,
  custom widget, drag area) where there's no index to pick.

Pass \`gridOverlay: true\` when you intend to call a coordinate tool
next — the screenshot will carry a 10×10 coordinate grid so you can
read pixel coordinates from cell centre labels.

Don't re-screenshot every step. The image stays available in the
preceding state messages for the model to reference; ask for a fresh
one when the visual state has actually changed.

## Coordinate tools (\`click_at\` / \`type_at\` / \`scroll_at\`)

These act through pixel coordinates. They REQUIRE a recent
screenshot taken with \`gridOverlay=true\` — coordinates from memory
of a previous page state will not line up after a layout change.

How to read coordinates: find the cell whose centre is on top of the
target, read the centre coordinate from its upper-left label, offset
within the cell using the grid spacing as a ruler. The runtime
converts image pixels to CSS pixels via \`window.devicePixelRatio\`,
so retina displays work transparently.

Coordinate tools are the right call for:
- canvas / video / custom widgets that the DOM listing cannot reach;
- elements that exist in the listing but where every DOM-tool attempt
  failed (DOM-fault path described above);
- drag operations (\`drag_at\`) and human-in-the-loop click handoff
  (\`hitl_click_at\`).

After \`click_at\`, the runtime checks whether url / scrollY / DOM
hash actually changed. If they didn't, you'll get an
\`Error: ... had no observable effect\` back — take a fresh
screenshot and pick different coordinates, don't loop on the same
spot.

## Other rules

- Do not transcribe the screenshot in your reasoning. You can see it;
  describing every pixel wastes tokens.
- Coordinate tools are not a substitute for navigation. Don't
  \`click_at\` the URL bar to "go to" a site — use \`go_to_url\`.
`;

export function buildReactVisionPrompt(): string {
  return `<system_instructions>${reactBaseSystemBody}\n${VISION_ON_RULES}\n</system_instructions>`;
}
