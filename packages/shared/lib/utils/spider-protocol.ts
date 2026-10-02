/**
 * Wire protocol between the background agent and the spider overlay that
 * the content script draws in the top frame of the agent's tab.
 *
 * All coordinates are CSS pixels in the top frame's viewport (the space
 * Puppeteer's `ElementHandle.boundingBox()` and `mouse.click()` use).
 * Types only — this file must stay free of runtime code because the
 * content script that imports it ships on every page.
 */
import type { SpiderLook } from '@extension/storage';

export type { SpiderColor, SpiderLook, SpiderMarks, SpiderPace } from '@extension/storage';

/**
 * What the agent is doing, as the spider shows it:
 * - `thinking`: a model call is running — it reads the page, steered by the focus words;
 * - `acting`: an interaction tool runs — alert, the approach/strike commands follow;
 * - `waiting`: a page is loading (navigation tools) — still, one leg tapping;
 * - `asking`: the agent waits for the user (HITL) — turns to the side panel, front legs up;
 * - `done` / `failed`: the task ended — a short gesture before it climbs away.
 */
export type SpiderMood = 'thinking' | 'acting' | 'waiting' | 'asking' | 'done' | 'failed';

export interface SpiderPoint {
  x: number;
  y: number;
}

export interface SpiderRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How the spider enters a page: `descend` on a thread (first appearance in a
 * task), `teleport` — it pops out at the exact viewport spot it left on the
 * previous page or tab — or `handoff`: the next page of the same tab, where
 * it simply stands on as it stood (same spot, heading and legs), drawn as
 * soon as the page has painted its content, so a navigation shows no gap —
 * or `edge`: it leaps in from beyond the nearer screen edge (from the chat
 * panel, which sits to the right of the page) and lands at `at`.
 */
export type SpiderArrival = 'descend' | 'teleport' | 'handoff' | 'edge';

/** Where the spider was and which way it faced, carried across pages. */
export interface SpiderPlace {
  x: number;
  y: number;
  heading: number;
  /** Feet relative to the body (viewport px), for a handoff that keeps the legs as they were. */
  feet?: SpiderPoint[];
  /** Abdomen relative to the body. */
  abdomen?: SpiderPoint;
}

export type SpiderCommand =
  | {
      op: 'spawn';
      look: SpiderLook;
      at?: SpiderPlace;
      arrive?: SpiderArrival;
      /** What the agent is doing and looking for at the moment of entry. */
      mood?: SpiderMood;
      focus?: string[];
    }
  | { op: 'tune'; look: SpiderLook }
  /** Walk until the hands reach `point`; resolves on arrival or after `capMs`. */
  | { op: 'approach'; point: SpiderPoint; rect?: SpiderRect; capMs: number }
  /** Tap `point` with both hands; resolves at the moment of contact. */
  | { op: 'strike'; point: SpiderPoint; rect?: SpiderRect }
  | { op: 'typing'; on: boolean }
  | { op: 'scroll'; dy: number }
  /** Clear the canvas before a screenshot; resolves once a cleared frame was presented. */
  | { op: 'hide' }
  | { op: 'show' }
  /** Climb out of view on a thread, then remove the overlay. */
  | { op: 'leave' }
  /** Collapse into a point before a tab switch; resolves when gone. */
  | { op: 'depart' }
  /** The tab is about to navigate: stand still where it is and report the full place (no collapse). */
  | { op: 'handoff' }
  /** Leap out over a screen edge (toward the chat panel: right), then remove the overlay; resolves when gone. */
  | { op: 'exit'; side: 'left' | 'right' }
  /** Viewport size and pixel ratio, for the page ↔ chat-panel seam. */
  | { op: 'metrics' }
  /**
   * Leave across the seam: glide from where it is (with its velocity) to `to`,
   * a point beyond the edge in this document's coordinates; the ack carries the
   * plan for the other side and when the spider is out of view. Removed at the end.
   */
  | { op: 'crossOut'; to: SpiderPoint; T: number; bow: number }
  /** Arrive across the seam: the same flight, already under way, in this document's coordinates. */
  | { op: 'crossIn'; plan: SpiderCrossPlan; look: SpiderLook; mood?: SpiderMood; focus?: string[] }
  /** The agent reads the DOM (a main-thread stall may follow): hold still until off. */
  | { op: 'scan'; on: boolean }
  /** What the agent is doing now (sent on change only). */
  | { op: 'mood'; mood: SpiderMood }
  /** Words of the task and the current subgoal: what the spider looks for while it reads. */
  | { op: 'focus'; words: string[] }
  /** Read-only pose snapshot, used by tests and debugging. */
  | { op: 'state' };

export interface SpiderPose {
  body: SpiderPoint;
  heading: number;
  mode: string;
  /** Overall drawing scale: 0 while teleported out, overshoots past 1 on arrival. */
  scale: number;
  /** Abdomen angle minus heading, radians — the follow-through on turns. */
  abdomenLag: number;
  /** Drawn hips and knees, one per leg (feet are in `feet`). */
  hips: SpiderPoint[];
  knees: SpiderPoint[];
  /** Longest drawn leg as a share of its bone length (never above 1). */
  maxStretch: number;
  /** Tips of the two hands (pedipalps). */
  hands: [SpiderPoint, SpiderPoint];
  /** Planted or swinging tips of the eight legs. */
  feet: SpiderPoint[];
  speed: number;
}

export interface SpiderEvent {
  /** `Date.now()` in the page. */
  t: number;
  op: string;
  arrived?: boolean;
  point?: SpiderPoint;
  body?: SpiderPoint;
}

export interface SpiderAck {
  ok: boolean;
  /** For `approach`: true only when the hands visibly reached the point. */
  arrived?: boolean;
  visible: boolean;
  /** Why an approach ended without arriving: cap, hidden tab, reduced motion, no animation frames. */
  reason?: 'cap' | 'hidden' | 'reduced-motion' | 'no-frames' | 'not-spawned';
  pose?: SpiderPose;
  events?: SpiderEvent[];
  /** Mean frame interval over the last second, ms (state only). */
  frameMs?: number;
  /** The last drawn frame: its number and `performance.now()` (state only) — exact timing for motion checks. */
  frame?: { n: number; t: number; epoch?: number };
  /** Words torn out of the page right now (state only). */
  stickers?: Array<{ text: string; rect: SpiderRect; phase: string }>;
  mood?: SpiderMood;
  /** For `handoff`: the full place (with legs) to stand on with on the next page. */
  place?: SpiderPlace;
  /** For `metrics`. */
  metrics?: SpiderMetrics;
  /** For `crossOut`: the flight as started here, and when the spider is fully out of view (epoch ms). */
  cross?: { plan: SpiderCrossPlan; clearAt: number };
}

export interface SpiderMetrics {
  width: number;
  height: number;
  dpr: number;
  outerWidth: number;
  /** The chat panel only: which side of the window it is docked on. */
  side?: 'left' | 'right';
}

/**
 * One flight seen from two documents: the same quintic glide (`motion.ts`),
 * started at `t0` on the shared clock, each side in its own CSS px. Both draw
 * it; each viewport shows its half.
 */
export interface SpiderCrossPlan {
  /** Epoch ms (`performance.timeOrigin + now`) when the glide started. */
  t0: number;
  T: number;
  from: SpiderPoint;
  /** Velocity at the start, px/s. */
  v0: SpiderPoint;
  to: SpiderPoint;
  bow: number;
  heading: number;
  /** Spider size in this document (the same physical size on both sides). */
  size: number;
}

export interface SpiderHelloReply {
  active: boolean;
  /** The spider waits in the chat panel: say `browd:spider:painted` once this page has painted. */
  parked?: boolean;
  look?: SpiderLook;
  at?: SpiderPlace;
  arrive?: SpiderArrival;
  mood?: SpiderMood;
  focus?: string[];
}

/** Background → content script. */
export interface SpiderMessage {
  type: 'browd:spider';
  cmd: SpiderCommand;
}

/** Content script → background, sent once per page load from the top frame. */
export interface SpiderHello {
  type: 'browd:spider:hello';
}

/** Content script → background as the page unloads: where the spider was. */
export interface SpiderPoseReport {
  type: 'browd:spider:pose';
  place: SpiderPlace;
}

/**
 * Background → side panel: during a burst of navigations the spider waits in
 * the chat panel instead of on pages that keep being replaced ("parked").
 */
export interface SpiderPanelMessage {
  type: 'browd:spider:panel';
  op: 'park' | 'unpark' | 'mood' | 'leave' | 'state' | 'metrics' | 'crossOut' | 'crossIn';
  look?: SpiderLook;
  mood?: SpiderMood;
  /** crossOut. */
  to?: SpiderPoint;
  T?: number;
  bow?: number;
  /** crossIn. */
  plan?: SpiderCrossPlan;
}

/** Content script → background: this page (told `parked`) has painted, so the old page is off screen. */
export interface SpiderPainted {
  type: 'browd:spider:painted';
}
