# Agent spider (experimental, branch `exp/spider`)

While the agent works in a tab, a small line-drawn spider lives on top of the
page and does the agent's actions with its own hands: it walks to the element
the agent is about to click, taps the exact click point, drums on a field while
the agent types, and climbs away on a thread when the task ends. You see where
the agent is acting without element highlight boxes.

## What it does

| Agent does | Spider does |
| --- | --- |
| attaches to a tab (task starts) | descends from the top on a thread and lands |
| thinks (model call) | wanders over the visible text; feet snap to the edges of words and links |
| `click_element`, `click_at`, `drag_at` | walks to the point (≈0.5 s), both hands tap it, a ring marks the contact, then the real click |
| `input_text`, `fill_field_by_label`, `type_at` | walks to the field, taps it, drums with both hands until the keys are in |
| scrolls | feet are planted in the page, so they ride with it and step back under the body |
| `screenshot()` and every other capture | disappears for the capture (the model and the Judge never see it), reappears after |
| navigates | the new page's content script asks the background and the spider descends again |
| task ends | climbs out of view and removes its element |

Motion: body on a spring (stiffness 150, damping 23 on approach; softer while
wandering), speed cap 2400 px/s, alternating four-leg gait, two-bone inverse
kinematics per leg, knees bend outward. `prefers-reduced-motion` turns every
move into a jump and stops the wandering.

## How it is wired

```
Page (background)                     content script (top frame)
  clickElementNode ── scrollIntoView    
    └ _spiderStrike(element)             
        boundingBox() ──► spiderBridge.strikeAt ──► { op: 'approach', point, rect, capMs }
                                         ◄── { arrived }            (walks there)
                                     ──► { op: 'strike', point }
                                         ◄── at the moment of contact
    └ element.click()                    
```

- `chrome-extension/src/background/browser/spider.ts` — `SpiderBridge`, the
  handles `Page` calls: `activate` / `deactivate` (on debugger attach/detach),
  `strikeAt`, `typing`, `scroll`, `hide` / `show`, `helloReply`. Every call is
  capped (approach 900 ms × pace, strike 350 ms, hide 300 ms) and swallows its
  own errors. A tab opened before the extension loaded has no content script:
  the bridge injects it once and retries. One log line per strike:
  `[Spider] strike tab=… at=x,y arrived=true struck=true ms=…`.
- `packages/shared/lib/utils/spider-protocol.ts` — the message types (types
  only; the content script must stay small).
- `pages/content/src/spider/engine.ts` — simulation and drawing.
  `pages/content/src/index.ts` — top-frame guard, message routing, the hello.
- `packages/storage/lib/settings/spider.ts` — settings (`spider-settings`),
  read live by the bridge; changes reach a spider already on screen.
- Options → General → **Agent spider**: on/off, size, pace, marks.

### Invariants (keep them when changing anything here)

1. **The site's DOM is never modified.** One host element is appended to
   `<html>` when the spider spawns and removed when it leaves; nothing else.
   Marks are drawn on the canvas over the element, never by restyling it —
   restyling moves layout under the agent's element indexes.
2. **The host element is never touched after creation.** The agent hashes
   `document.documentElement.outerHTML` around coordinate clicks
   (`readClickSignature`); hide/show changes a style inside the shadow root.
3. **Closed shadow root, `pointer-events: none`.** Page scripts cannot reach
   it, real clicks and `elementFromPoint` go through it (the DOM builder's
   top-element check depends on that).
4. **Nothing on pages the agent is not driving.** No task, no element.
5. **Decoration never fails or stalls an action.** Caps everywhere; a
   background tab (no animation frames) resolves at once.
6. **Benchmarks run without it.** `bench/om2w/run.mjs` writes
   `spider-settings.enabled = false`, otherwise it would be in every
   trajectory screenshot the WebJudge grades.

## Checks

Both tiers drive the built `dist/` in Playwright's Chromium, headless, $0:

```bash
pnpm build
cd bench/spider && npm ci
node e2e.mjs            # tier A: content script + overlay, no model
node pipeline.mjs       # tier B: the real agent on a scripted localhost model
node pipeline.mjs --marks feet --size 1.35   # same run, other look; writes agent-feet.mp4
```

Output: `bench-runs/spider-e2e/<stamp>/` and `bench-runs/spider-pipeline/<stamp>/`
(`report.json`, the model requests, a video and an mp4 preview).

Tier A (`e2e.mjs`), last run 14/14, 1 skipped:

| | Check | Measured |
| --- | --- | --- |
| C1 | no element on a page without a task | none |
| C2 | descends and lands at the requested point | landed after 611 ms, 5.5 px off |
| C3 | closed shadow root on `<html>`, no pointer events | yes |
| C4 | 6 s of wandering: moves, page DOM unchanged | 364 px wandered, 0 mutations, outerHTML hash equal |
| C5 | frame budget on a 140-reference page | 16.7 ms per frame, 0 long tasks |
| C6 | approach to a button 499 px away | arrived in 514 ms, hands 2.5 px from the point |
| C7 | no jumps on the way | max 37.8 px per frame (cap ≈ 40) |
| C8 | strike, then a real click at the point | click reached the button 7 ms after the strike |
| C9 | typing | text arrived, hands drummed |
| C10 | page scroll | feet stretched to 361 px with the page, back to 64 px after 1.3 s |
| C11 | background tab resolves at once | **skipped headless** (tabs stay visible); runs with `--headed` |
| C12 | hidden spider in a screenshot | 0 px hidden vs 1843 px visible |
| C13 | leave removes the element | yes |
| C14 | after navigation, nothing until told | `not-spawned` |
| C15 | reduced motion | jump in 1 ms, no descent, no wandering |

Tier B (`pipeline.mjs`), last run 9/9. The task crosses a navigation, types into
a field, clicks a button and takes a screenshot; the model is a scripted
OpenAI-compatible server on localhost (`plan` → `click_element` → `input_text`
→ `click_element` → `screenshot` → `task_complete`):

| | Check | Measured |
| --- | --- | --- |
| P1 | the real pipeline completes the task | `task.ok`, form submitted |
| P2 | first page: spawned on attach, tapped the link | `arrived=true struck=true` |
| P3 | second page: the hello brings it back before the first action | 1.1–1.2 s before |
| P4 | every keystroke inside the drumming window | 19 of 19 |
| P5 | strike at the click point before the real click | 17–19 ms before, 0.9 px apart |
| P6 | the agent's screenshot has no spider | 0 px; control with the spider drawn at that spot: 2360 px |
| P7 | shadow root stays closed under the agent's `attachShadow` override | 55 of 55 samples |
| P8 | task end: leaves and removes itself | yes |
| P9 | added time per action (bridge-measured) | 423–611 ms, mean 478–519 ms |

Unit tests: `chrome-extension/src/background/browser/__tests__/spiderBridge.test.ts`
(disabled sends nothing, never throws, caps hold, injection once, respawn and
retry, live settings, pace scales the cap).

## Open questions for a manual pass

Each is a hypothesis the automated runs could not settle. «Check» is what to
do in your own Chrome with the unpacked `dist/` (disable every other Browd
copy first).

| # | Hypothesis | Check |
| --- | --- | --- |
| H1 | Readable on real sites, dark and light, without hiding what the agent clicks | Task on a Wikipedia article in dark mode, then on a light site; watch two clicks |
| H2 | The hands land where the real click lands on a real site | Watch the ring at a button and the page reacting; SW console shows `arrived=true` |
| H3 | ≈0.5 s per click/type is an acceptable price | Same task with the spider on and off (Options toggle); compare wall time. Pace «Fast» cuts the cap to 0.7× |
| H4 | Agent tab in the background does not wait for frames | Agent tab focus = background; SW console lines show `reason=hidden` and `ms` near 0 (C11 is headed-only) |
| H5 | Vision screenshots stay clean on real sites | Vision model; TRACE thumbnails show no spider |
| H6 | A tab opened before the extension reload still gets the spider | Reload the extension, start a task in an old tab; the spider appears at the first action |
| H7 | Heavy pages stay smooth | Long Wikipedia article, a web app with a canvas; DevTools Performance during wandering |
| H8 | React/Next pages that hydrate `<html>` or transform it are unaffected | A Next.js site; the element is appended after load, check the console for hydration errors and that the spider stays in place |
| H9 | Anti-bot sites block no more often than before | The Akamai-blocked OM2W pages, spider on vs off |
| H10 | Which marks default: `target` (one outline), `feet` (outline everything gripped) or `off` | Try all three live in Options during one task |
| H11 | Reduced motion is respected | macOS Reduce motion on: jumps, no wandering |
| H12 | A new tab opened by the agent gets its own spider | Task that opens a link in a new tab and works there |

## If it looks wrong

- **It never walks, only jumps, and does not wander:** the OS has Reduce motion on
  (macOS: Accessibility → Display). That is the reduced-motion path, by design.
- **Numbered boxes all over the page compete with it:** Options → Display
  Highlights is on (the default). Turn it off; the spider replaces them.
- **No spider at all:** Options → Agent spider is off, or another Browd copy is
  enabled (Chrome then refuses the debugger and nothing attaches).

## Known limits

- `send_keys`, `select_dropdown_option` and `scroll_to_text` have no spider
  step: Enter presses and dropdown picks happen without a tap.

- Scrolling inside a scrollable element (not the page) moves content under
  planted feet without them following; they re-step only when stretched.
- Targets inside cross-origin iframes get their point from the main frame's
  box model; not covered by the fixtures.
- `position: fixed` breaks if a site transforms `<html>`; the spider then
  scrolls with the page.
- The hello is one runtime message per top-frame page load, also when no task
  runs (the background answers `active: false`).
