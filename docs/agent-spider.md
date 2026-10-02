# Agent spider (experimental, branch `exp/spider`)

While the agent works in a tab, a long-legged line-drawn spider lives on top of
the page and shows what the agent is doing. While the model thinks, it reads the
page the way a spider moves — bursts and freezes, a front leg feeling ahead —
goes to the words the task is about and tears them out of the page; before a
click it leaps to the element and taps the exact point; it drums on a field while
the agent types; it waits while a page loads, turns to the side panel when the
agent asks you something, and when the agent moves to another page it collapses
where it was and reappears at the same spot there.

## What it does

| Agent | Spider |
| --- | --- |
| starts a task in a tab | descends from the top on a thread and lands (first entrance only) |
| a model call runs (*thinking*) | reads: walks to a text block that mentions the focus words, steps along the lines in bursts with freezes, goes straight to a focus word and tears it out (a tilted tag pulled by a front leg; a hole left in the line), then the next block |
| an interaction tool starts (*acting*) | alert; no new tearing |
| `click_element`, `click_at`, `drag_at` | crouches, leaps with legs gathered (≈0.5 s), lands with them spread, winds up and taps the point; a ring marks the contact; then the real click. Every torn word goes home first |
| `input_text`, `fill_field_by_label`, `type_at` | goes to the field, taps it, drums with both hands until the keys are in |
| navigates (link, `go_to_url`) | tucks and collapses into a point with a ring; the next page closes a ring at the same spot, it pops out facing the same way and looks around (*waiting* until the agent moves) |
| works in another tab | the same teleport, tab to tab — one spider per task (bridge unit-tested; not yet seen end to end, see H4) |
| asks you (HITL approve / ask) | turns toward the side panel, front legs up, hands waving |
| scrolls a little (wheel) | feet are planted in the page: they ride with it and step |
| scrolls far (`scroll_to_bottom`) | a cut: the page carries it a few dozen px, the feet re-grip, it springs back |
| any screenshot | disappears for the capture — spider and torn words; the model and the Judge never see it |
| task done / failed | a quick full turn on tiptoe / a droop, then it climbs away on a thread |

**Focus words** come from the task text and the active subgoal of the plan:
names and topic words, no verbs, fillers or URLs; capitals-only two-letter words
(AI) are kept; plurals are trimmed so a prefix match finds both forms. Short words
match whole («ai» does not catch «aim»); matching is Unicode-aware, so a Russian
task finds Russian words.

**Torn words are drawn, not moved.** The page's DOM is never touched: the word's
spot is painted over in the solid colour behind it, and a copy of the word is drawn
as a sticker — either a filled tag in monospace (the reference look) or the page's
own font with an outline. At most three at once; skipped over images and
gradients; every action takes them all back.

### Motion

- **Anatomy.** Small head with four eyes, pedicel, abdomen on its own looser spring
  (lags on turns, swings once on stops). Legs about 200 px span at size 1.
- **Legs.** Four pairs, femur thicker than tibia, the tibia drawn as an arc
  bowed away from the body. Seen from above, each femur keeps its own direction
  out of the body (a fan of knees, following its foot by at most ±0.24 rad) and the
  tibia reaches the foot. Each foot keeps to its own sector, ±0.25 rad around its
  rest direction: a step never aims past it nor under the body (≥ 0.85 of the rest
  distance), a planted foot steps at once before it drifts out, and a swing travels
  an arc around the hip, not a chord. Neighbouring rests are 0.7–0.9 rad apart, so
  two legs never meet. A leg is never drawn or simulated longer than its bones; a
  planted foot the page outruns slips at full reach. Feet snap to the edges of
  words they land on.
- **Turning.** On planted feet the body turns at ≤ 2.6 rad/s with a soft start
  (≤ 22 rad/s²) and every step aims where the foot belongs when it lands; a turn
  that outran the steps left feet behind and pulled tibias across neighbours (the
  «washcloth» look, 02.10). The done gesture is a quick turn on tiptoe: the feet
  turn with the body instead of stepping.
- **Glides, not bursts (owner 02.10: «НЕ рывками а максимально плавно»).** Every
  move — reading, a walk to a block, an approach, the descent, the climb out — is a
  glide (`motion.ts`): a quintic from where the body is, *with the velocity it
  already has*, to a goal reached at a chosen speed (usually rest), optionally
  bowed into a slight arc. Position, velocity and acceleration are continuous at
  both ends, so nothing starts or stops with a kick and a new move takes over a
  running one without a hitch. The body follows the glide through a stiff spring
  with the glide's velocity and acceleration fed forward: it stays on the path, no
  lag, no overshoot. Stopping is reserved for meaning: a focus word (it tears it
  out) and the end of what it read (a look around). Reading = one line per block,
  the hands running along it at ~100 px/s like a finger; a walk to a block arcs
  (5–9 % of its length) and flows straight into reading without stopping, its peak
  held near 380 px/s (long walks take longer instead of rushing). Mood changes,
  scrolls and the agent's DOM reads ease out along the way it was going — never a
  brake. The earlier stop-and-go (60–130 px bursts and freezes, ~2 pulses a second)
  was dropped on purpose.
- **Gait.** Alternating four-leg groups; stride rate rises with speed (≈4.5 steps
  per leg per second at speed, ≈0.4 standing). Layout is read once per block
  (words, lines), never per step: feet snap to those known boxes.
- **Page stalls.** While the agent builds the DOM (a main-thread job that can freeze
  a heavy page for 100+ ms) the spider eases to a stop and starts no new move, so
  a stall reads as a pause instead of a hitch mid-move (`PagePresence.scanning`).
- **Approach.** One glide of 0.38–0.72 s (about half a second, so the eye can follow
  it to the click), a slight arc leaning the way the head points, a crouch while the
  glide is still slow (anticipation without backing up). Fast stretches are a leap:
  legs gathered, body slightly larger; on landing the legs unfold in one quick step
  from where they were (they used to appear at their spots), and a squash. No
  overshoot: the abdomen's own spring is the follow-through.
- **Colour.** One colour by default (violet); ink, white, cyan, magenta, or the
  rainbow drift of the reference. The under-stroke flips with the colour's
  lightness so it reads on dark and light pages.
- `prefers-reduced-motion`: every move is a jump, no descent, no reading walk, no tearing.

## How it is wired

```
background                                         content script (top frame)
  Page ──► PagePresence (presence.ts)                Spider (engine.ts) — commands, modes, frame loop
            beforePointer · typing · beforeCapture      Rig (rig.ts)         body, legs, hands, drawing
            beforeNavigate · attached · detached         Brain (brain.ts)     behaviour by mood
                 │                                       Stickers (stickers.ts) torn words
                 ▼                                       motion.ts            glides (any character)
                                                         reader.ts            blocks, lines, focus words
           SpiderBridge (spider.ts) ── messages ──►      Overlay (overlay.ts) the one host element + canvas
                 ▲                                       palette.ts           colours
  executor events ──► onAgentEvent ── agentMood.ts (mood + focus words, pure)
```

- **One seam on the page side.** `Page` knows only `PagePresence`
  (`browser/presence.ts`): `showing`, `attached` / `detached`, `beforePointer`,
  `typing`, `scrolled`, `beforeNavigate`, `beforeCapture` / `afterCapture`. The
  background wires the spider in once (`setPagePresence(spiderBridge)`); with
  nothing wired, every call is a no-op.
- **One subscription on the agent side.** `subscribeToExecutorEvents` calls
  `spiderBridge.onAgentEvent(event)`; `agentMood.ts` turns events into a mood
  (`act.start` → acting, `act.ok/fail` → thinking, HITL → asking, task end → done
  / failed, and the live `tool_start` / `llm_streaming` stream when it reaches the
  outer graph) and plan events into focus words. The bridge sends `mood` and
  `focus` only when they change; a spawn carries the current ones.
- `SpiderBridge` keeps one spider per task in the current tab and the last place
  it stood (never from a spider still on its thread or mid-teleport). Every call
  is capped and swallows its own errors. Log lines: `[Spider] strike … arrived=…
  ms=…`, `move tab=a→b`, `unload … at=x,y`, `depart …`.
- Settings `spider-settings` (`packages/storage/lib/settings/spider.ts`): on/off,
  size, pace, marks, colour, tear. Options → General → **Agent spider**; the spider
  button in the chat input toggles it, also mid-task.

### Invariants (keep them when changing anything here)

1. **The site's DOM is never modified.** One host element on `<html>` while the
   spider is shown; torn words, marks and holes are canvas drawing.
2. **The host element is never touched after creation** (`readClickSignature`
   hashes `outerHTML`); hide/show changes a style inside the shadow root.
3. **Closed shadow root, `pointer-events: none`.**
4. **Nothing on pages the agent is not driving.**
5. **One spider per task**, in the current tab; other tabs get `active: false`.
6. **Decoration never fails or stalls an action**; layout reads (blocks, words)
   happen on the spider's own schedule, never per frame.
7. **Legs never stretch** past their bones, drawn or simulated, and **never meet**
   each other (C12, C23).
8. **Captures never contain it** — spider and torn words.
9. **Benchmarks run without it** (`bench/om2w/run.mjs` writes `enabled: false`).

## Checks

All drive the built `dist/` in Playwright's Chromium, headless, $0:

```bash
pnpm build
cd bench/spider && npm ci
node e2e.mjs            # tier A: content script + overlay, no model
node pipeline.mjs       # tier B: the real agent on a scripted localhost model (thinks 1.2 s per call)
node demo.mjs           # choreographed preview video of every move
node motion.mjs         # frame-by-frame strips: descend, leap, scrolls, read, tear, asking, depart, teleport
node studio.mjs [size] [colour]   # 3× close-up stills for a design check
```

Tier A (`e2e.mjs`), last runs 25/25, 1 skipped (02.10):

| | Check | Measured |
| --- | --- | --- |
| C1 | no element on a page without a task | none |
| C2 | first entrance: descends and lands | ~630 ms, ≤5 px off |
| C3 | closed shadow root on `<html>`, no pointer events | yes |
| C4 | 12 s of thinking: reads ≥2 blocks gliding — moving ≥60 % of the time, ≤4 stops and ≤6 speed pulses per 10 s, DOM unchanged | 2–3 blocks, moving 83–86 %, 1.7 stops and ~4 pulses per 10 s (bursts gave ~13 and ~21), peak ~420 px/s, 0 mutations |
| C4b | focus words get torn out, DOM untouched | first word after ~2.6 s, 0 mutations |
| C4c | an action sends every torn word home | all `back` at once, gone within 0.9 s |
| C5 | frame budget while reading and tearing | 16.7 ms per frame, 0 long tasks |
| C6 | approach to a button ~345 px away | arrived in ~525 ms, hands 2.5 px from the point |
| C7 | one glide: no backing up, acceleration in budget and without a kick, legs gathered at speed, no bounce | pull back 0, peak accel ~7 400 px/s² (the old spring: ~92 000), max change of acceleration per frame ~2 300 px/s² (old: ~58 000 in one frame), overshoot 2 px (= the test's own tip offset), legs gathered to 44 px |
| C8 | strike, then a real click at the point | click reached the button ~11 ms after the strike |
| C9 | typing | text arrived, hands drummed |
| C10 | `scrollTo(bottom)` | longest drawn leg 92.7 of 98 px, stretch ≤0.97, back within 1.7 px |
| C10b | small wheel scroll | walked, no cut, stretch ≤0.99 |
| C11 | background tab resolves at once | **skipped headless**; runs with `--headed` |
| C12 | knees fan out in order, never on a neighbour | 0 out of order, min gap 0.15–0.17 rad over ~17 000 samples |
| C13 | depart, then the next action brings it back | ~205 ms, then arrived |
| C14 | teleport arrival | exact spot and heading, scale 0 → 1.10 → 1, no descent |
| C15 | captures with the spider and a torn word on screen | 0 px hidden vs ~4400 px visible |
| C16 | leave removes the element | yes |
| C17 | after navigation, nothing until told | `not-spawned` |
| C18 | reduced motion | jump in ≤5 ms, no descent, no reading walk |
| C19 | moods | waiting: speed 0, a front foot tapping 12 px; asking: heading 0 (toward the panel); done: 6.0 rad turn |
| C20 | smooth reading (frame clock of the page), p95 change of velocity per frame ≤ 40 px/s | 9–15 px/s, peak ~420 px/s (bursts: 44–50; before them: 144 and 726) |
| C21 | heavy never-still page (~20k nodes, a style change every frame) | 0 extra dropped frames with the spider reading and tearing |
| C22 | the agent reads the DOM | eases from 147 px/s to rest, no new move, drift 0.1 px |
| C23 | legs never touch away from the body (idle and busy samples) | 0 touching points, closest 3.6–5.6 px in three runs (before: ~1300 points, 2.6 % of poses); a failure names the scenario line and writes `touching-poses.json` |

Tier B (`pipeline.mjs`), last run 12/12 — navigation, typing, a click, a screenshot;
scripted OpenAI-compatible model on localhost that takes 1.2 s per call:

| | Check | Measured |
| --- | --- | --- |
| P1 | the real pipeline completes the task | `task.ok`, form submitted |
| P2 | first page: spawned, got the focus words and the thinking mood, read, tapped the link | `focus:join,arachnid,society,second,… mood:thinking spawn landed read approach arrive` |
| P3 | the navigation is a teleport | same spot ±0.5 px, before the first action, no descent |
| P4 | every keystroke inside the drumming window | 19 of 19 |
| P5 | strike at the click point before the real click | ~18 ms before, 0.9 px apart |
| P6 | the agent's screenshot has no spider | 0 px; control with the spider drawn there: ~2600 px |
| P7 | shadow root stays closed under the agent's `attachShadow` override | all samples |
| P8 | task end: done gesture, then it leaves and removes itself | yes |
| P9 | added time per action | ~560–630 ms, mean ~585 ms (bursts era: ~480; the half-second flight is the price of a move the eye can follow) |
| P10 | moods follow the agent | thinking → acting → done; done gesture ≥600 ms before the climb; words torn during the run |
| P11 | the chat toggle mid-task | gone in ~0.5 s, back in ~10 ms |
| P12 | the agent's DOM reads reach the spider first | 9 scan windows in the run |

Unit tests: `chrome-extension/src/background/browser/__tests__/spiderBridge.test.ts`
(18: tab teleports, hello only from the current tab, place only from a standing
spider, focus words from the task and the active subgoal, moods sent once per
change with the ending mood before the climb, toggle on mid-task, disabled sends
nothing, never throws, caps, injection, respawn, live settings, pace).

## Open questions for a manual pass

| # | Hypothesis | Check |
| --- | --- | --- |
| H1 | The gliding reads as calm and alive (not robotic) on real sites, dark and light | HN, Wikipedia; watch one minute |
| H2 | Reading picks sensible blocks on real layouts (lists, cards, comments), not chrome or ads | Watch it while the model thinks on HN and a news site |
| H3 | The torn words are the ones that matter and don't get in the way | A task with clear topic words; are the torn ones on topic; does anything you want to read stay covered |
| H4 | Tab switches teleport too | A task that opens a link in a new tab |
| H5 | The moods match what you see the agent do | Watch thinking / acting / waiting / asking with a real model; `act.*` events drive acting |
| H6 | ≈0.5 s per click/type is an acceptable price | Spider on vs off (chat button) on the same task |
| H7 | Vision screenshots stay clean (spider and torn words) | Vision model; TRACE thumbnails |
| H8 | Heavy pages stay smooth while it reads and tears | Long Wikipedia article; DevTools Performance |
| H9 | Which colour default: violet, ink, white, cyan, magenta, rainbow | Try in Options during a task |
| H10 | Pages with gradient or image backgrounds simply skip tearing | A landing page with a hero gradient |

## Design note: other characters (proposal, not built)

The behaviour is already mostly character-agnostic: `motion.ts` (glides) knows
nothing about legs, `brain.ts` decides where and when, `engine.ts` runs commands
and modes. What is spider-specific is `rig.ts` — and the brain calls into it.
The seam for swapping the character (a micro-pet, or something for people who
dislike spiders):

- **Body kinematics — generic.** Position, velocity, heading with its turn cap,
  scale (pop in / collapse), crouch/squash, scroll sync, following a `Control`.
- **`Character` — per creature.** Gestures the brain and the engine ask for:
  `reach(point)` (hands on a target), `tap(point, onContact)`, `type(on)`,
  `feel(side, point)` (a limb lifted toward a point), `pull(side) → tip` (what holds
  a torn word), `wave()`, `idleTap()`, `crouch()`, `spin()`, `tuck()` / `land()`,
  plus `draw(ctx)` and `pose()` for the checks. Moods map to gestures, not to legs.
- **Candidates without legs:** a jelly blob with two eyes (squash-and-stretch on
  every glide, a pseudopod reaches for the click and pulls words), a firefly / orb
  with a light trail (minimal, reads as «attention» rather than a creature).
- **Checks** split the same way: motion checks (C4, C7, C20, C22) run for every
  character; anatomy checks (C10 stretch, C12, C23 legs) are the spider's.

## If it looks wrong

- **It never walks, only jumps:** the OS has Reduce motion on.
- **Numbered boxes compete with it:** Options → Display Highlights is on; turn it off.
- **No spider:** the chat spider button is off, Options → Agent spider is off, another
  Browd copy is enabled, or the browser loads the extension from another folder.

## Known limits

- `send_keys`, `select_dropdown_option` and `scroll_to_text` have no spider step.
- The live `tool_start` stream of a subgoal's inner agent does not always reach the
  outer graph; the acting mood comes from `act.start`.
- Scrolling inside a scrollable element does not move the planted feet with it.
- Targets in cross-origin iframes get their point from the main frame's box model.
- If a navigation commits very fast, the collapse on the old page is cut short.
- The hello is one runtime message per top-frame page load, also with no task.
