# Agent spider (experimental, branch `exp/spider`)

While the agent works in a tab, a small line-drawn spider lives on top of the
page and does the agent's actions with its own hands: between actions it reads
the page block by block, before a click it leaps to the element and taps the
exact click point, it drums on a field while the agent types, and when the agent
moves to another page it collapses where it was and reappears at the same spot
there. You see where the agent is looking and acting without element highlight
boxes.

## What it does

| Agent does | Spider does |
| --- | --- |
| starts a task in a tab | descends from the top on a thread and lands (first entrance only) |
| thinks (model call) | reads: walks to a text block, runs its hands along the first lines, looks up, moves to the next block below |
| `click_element`, `click_at`, `drag_at` | crouches, leaps with legs gathered (≈0.5 s), lands with them spread, winds up and taps the point; a ring marks the contact; then the real click |
| `input_text`, `fill_field_by_label`, `type_at` | goes to the field, taps it, drums with both hands until the keys are in |
| scrolls a little (wheel) | feet are planted in the page: they ride with it and step |
| scrolls far (`scroll_to_bottom`, instant jumps) | a cut: the page carries it a few dozen px, the feet re-grip at once, it springs back to its spot |
| `screenshot()` and every other capture | disappears for the capture (the model and the Judge never see it), reappears after |
| navigates (link, `go_to_url`) | tucks and collapses into a point with a ring on the old page; the new page closes a ring at the same spot and it pops out with an overshoot, facing the same way |
| works in another tab | the same teleport, from the old tab to the new one — one spider per task |
| task ends | climbs out of view on a thread and removes its element |

### Motion

- **Anatomy.** Head (cephalothorax) with four eyes, a pedicel and a larger
  abdomen behind it. The abdomen hangs on its own looser spring: it lags on
  turns and swings once when the spider stops (follow-through).
- **Legs.** Four pairs, femur thicker than tibia. Each leg is solved in a
  vertical plane with the knee always up (pseudo-3D, slight oblique lift), and
  bowed outward by a fixed rule — front pairs toward the tail, rear pairs toward
  the head — so a knee can never flip sides. A leg is never drawn longer than its
  bones; a planted foot that the page carries too far slips along at full reach
  until it steps. Feet snap to the edges of words and links they land on.
- **Gait.** Alternating four-leg groups; stride rate rises with speed, groups may
  overlap at a brisk walk; steps lead the motion by a capped amount.
- **Darts.** A long approach (>120 px) is a leap: 75 ms crouch and pull back
  (anticipation), legs gathered under the body in flight, the body slightly
  larger (coming up), landing with the feet planted around where it will settle
  and a squash; one overshoot of ~5 px, then rest (spring stiffness 170,
  damping 20). Short moves are walked.
- **Hands.** Two pedipalps: wind-up (60 ms), jab to contact (100 ms), recoil;
  they feel the text while reading and drum while typing.
- `prefers-reduced-motion`: every move is a jump, no descent, no reading walk.

## How it is wired

```
Page (background)                     content script (top frame)
  clickElementNode ── scrollIntoView
    └ _spiderStrike(element)
        boundingBox() ──► spiderBridge.strikeAt ──► { op: 'approach', point, rect, capMs }
                                         ◄── { arrived }            (leaps there)
                                     ──► { op: 'strike', point }
                                         ◄── at the moment of contact
    └ element.click()
  navigateTo ──► spiderBridge.depart ──► { op: 'depart' }   (collapse, ~200 ms)
    └ page.goto
                                      old page: beforeunload ──► { type: 'browd:spider:pose', place }
                                      new page: hello ◄── { active, at: place, arrive: 'teleport' }
```

- `chrome-extension/src/background/browser/spider.ts` — `SpiderBridge`, the
  handles `Page` calls: `activate` / `deactivate` (on debugger attach/detach),
  `strikeAt`, `typing`, `scroll`, `depart`, `hide` / `show`, `helloReply`,
  `reportPlace`. It keeps one spider per task in the **current** tab and the
  last place it was seen; moving to another tab departs the old one and spawns a
  teleport in the new one. Every call is capped (approach 900 ms × pace, strike
  350 ms, depart 350 ms, hide 300 ms) and swallows its own errors. A tab opened
  before the extension loaded has no content script: the bridge injects it once
  and retries. Log lines: `[Spider] strike tab=… at=x,y arrived=true struck=true
  ms=…`, `[Spider] move tab=a→b arrive=teleport`, `[Spider] unload tab=… at=x,y`.
- `packages/shared/lib/utils/spider-protocol.ts` — the message types (types
  only; the content script must stay small).
- `pages/content/src/spider/engine.ts` — simulation and drawing;
  `reader.ts` — text blocks and their line boxes; `geometry.ts` — the leg solver
  and springs. `pages/content/src/index.ts` — top-frame guard, message routing,
  the hello, the unload report.
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
5. **One spider per task.** Only the current tab answers the hello; any other
   tab gets `active: false`.
6. **Decoration never fails or stalls an action.** Caps everywhere; a
   background tab (no animation frames) resolves at once. Reading samples the
   layout every few seconds, never per frame.
7. **Legs never stretch.** Drawn and simulated foot distance ≤ bone length.
8. **Benchmarks run without it.** `bench/om2w/run.mjs` writes
   `spider-settings.enabled = false`, otherwise it would be in every
   trajectory screenshot the WebJudge grades.

## Checks

All drive the built `dist/` in Playwright's Chromium, headless, $0:

```bash
pnpm build
cd bench/spider && npm ci
node e2e.mjs            # tier A: content script + overlay, no model
node pipeline.mjs       # tier B: the real agent on a scripted localhost model
node pipeline.mjs --marks feet --size 1.35   # same run, other look; writes agent-feet.mp4
node demo.mjs           # choreographed preview video of every move
node motion.mjs         # frame-by-frame strips: descend, leap, scrolls, read, depart, teleport
node studio.mjs         # 3× close-up stills for a design check
```

Output lands in `bench-runs/spider-*/<stamp>/` (`report.json`, videos, strips).

Tier A (`e2e.mjs`), last runs 18/18 twice, 1 skipped:

| | Check | Measured |
| --- | --- | --- |
| C1 | no element on a page without a task | none |
| C2 | first entrance: descends and lands at the requested point | landed after ~620 ms, ≤5 px off |
| C3 | closed shadow root on `<html>`, no pointer events | yes |
| C4 | 9 s between actions: reads ≥2 blocks, hands on the text, page DOM unchanged | 3 blocks, hands on text 0.80–0.84 of samples, 0 mutations |
| C5 | frame budget while reading a 140-reference page | 16.6–16.7 ms per frame, 0 long tasks |
| C6 | approach to a button ~350 px away | arrived in ~530 ms, hands 2.5 px from the point |
| C7 | anticipation, leap, overshoot, no jumps | pull back 2.2–2.5 px, legs gathered to ~36 px at peak speed (standing ~61), overshoot ~5.4 px, max 36 px per frame |
| C8 | strike, then a real click at the point | click reached the button 6–10 ms after the strike |
| C9 | typing | text arrived, hands drummed |
| C10 | `scrollTo(bottom)` (the owner's case) | longest drawn leg 62.5 px of 70, simulated stretch ≤0.91, body on screen, back within 1.7 px |
| C10b | small wheel scroll | walked, no cut, stretch ≤1 |
| C11 | background tab resolves at once | **skipped headless** (tabs stay visible); runs with `--headed` |
| C12 | knees never flip | 0 legs of 8 over ~16 000 samples |
| C13 | depart, then the next action brings it back | collapsed in ~210 ms, invisible, then arrived |
| C14 | teleport arrival | exact spot (0 px) and heading, scale 0 → 1.10 → 1, no descent |
| C15 | hidden spider in a screenshot | 0 px hidden vs ~1800 px visible |
| C16 | leave removes the element | yes |
| C17 | after navigation, nothing until told | `not-spawned` |
| C18 | reduced motion | jump in ≤5 ms, no descent, no reading walk |

Tier B (`pipeline.mjs`), last run 9/9. The task crosses a navigation, types into
a field, clicks a button and takes a screenshot; the model is a scripted
OpenAI-compatible server on localhost (`plan` → `click_element` → `input_text`
→ `click_element` → `screenshot` → `task_complete`):

| | Check | Measured |
| --- | --- | --- |
| P1 | the real pipeline completes the task | `task.ok`, form submitted |
| P2 | first page: spawned on attach, read while the model thought, leapt to the link | `spawn landed read approach leap-land arrive`, `arrived=true struck=true` |
| P3 | the navigation is a teleport | unload reported 383,308; the next page spawned a teleport at 383,308 (0.5 px), 1.2 s before acting, no descent |
| P4 | every keystroke inside the drumming window | 19 of 19 |
| P5 | strike at the click point before the real click | 19 ms before, 0.9 px apart |
| P6 | the agent's screenshot has no spider | 0 px; control with the spider drawn at that spot: 2153 px |
| P7 | shadow root stays closed under the agent's `attachShadow` override | 55 of 55 samples |
| P8 | task end: leaves and removes itself | yes |
| P9 | added time per action (bridge-measured) | 509–538 ms, mean 523 ms |

Unit tests: `chrome-extension/src/background/browser/__tests__/spiderBridge.test.ts`
(14: one spider moves between tabs as a teleport, hello only from the current
tab, place reports, the next task descends again, depart only on the current
tab, disabled sends nothing, never throws, caps hold, injection once, respawn
and retry, live settings, pace scales the cap).

## Open questions for a manual pass

Each is a hypothesis the automated runs could not settle. «Check» is what to
do in your own browser with the unpacked `dist/` (disable every other Browd
copy first).

| # | Hypothesis | Check |
| --- | --- | --- |
| H1 | Readable on real sites, dark and light, without hiding what the agent clicks | Task on Hacker News / Wikipedia; watch two clicks |
| H2 | Reading picks sensible blocks on real layouts (lists, cards, comment threads), not chrome or ads | Watch the spider while the model thinks on HN and on a news site |
| H3 | The teleport reads as the same spider moving on, also when the next page is slow to load | A task with 3+ navigations; a slow site (the old page keeps painting until the new one commits) |
| H4 | Tab switches teleport too | Task that opens a link in a new tab and works there |
| H5 | ≈0.5 s per click/type is an acceptable price | Same task with the spider on and off; pace «Fast» cuts the cap to 0.7× |
| H6 | Agent tab in the background does not wait for frames | Agent tab focus = background; SW console lines show `reason=hidden` and `ms` near 0 (C11 is headed-only) |
| H7 | Vision screenshots stay clean on real sites | Vision model; TRACE thumbnails show no spider |
| H8 | Heavy pages stay smooth while it reads | Long Wikipedia article, a web app with a canvas; DevTools Performance |
| H9 | React/Next pages that hydrate `<html>` are unaffected | A Next.js site; console clean, spider stays in place |
| H10 | Anti-bot sites block no more often than before | The Akamai-blocked OM2W pages, spider on vs off |
| H11 | Which marks default: `target`, `feet` or `off` | Try all three live in Options during one task |
| H12 | Single-page apps (no unload on route change) keep the spider on screen without a teleport | GitHub or Gmail-like SPA navigation |

## If it looks wrong

- **It never walks, only jumps, and does not read:** the OS has Reduce motion on
  (macOS: Accessibility → Display). That is the reduced-motion path, by design.
- **Numbered boxes all over the page compete with it:** Options → Display
  Highlights is on (the default). Turn it off; the spider replaces them.
- **No spider at all:** Options → Agent spider is off, another Browd copy is
  enabled (Chrome then refuses the debugger and nothing attaches), or the browser
  loads the extension from a different folder than the one rebuilt.

## Known limits

- `send_keys`, `select_dropdown_option` and `scroll_to_text` have no spider
  step: Enter presses and dropdown picks happen without a tap.
- Scrolling inside a scrollable element (not the page) moves content under
  planted feet without them following; they re-step when stretched.
- Targets inside cross-origin iframes get their point from the main frame's
  box model; not covered by the fixtures.
- `position: fixed` breaks if a site transforms `<html>`; the spider then
  scrolls with the page.
- If a navigation commits very fast, the collapse on the old page is cut short;
  the arrival on the new page still plays in full.
- The hello is one runtime message per top-frame page load, also when no task
  runs (the background answers `active: false`).
