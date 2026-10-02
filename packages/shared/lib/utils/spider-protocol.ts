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

export type { SpiderLook, SpiderMarks, SpiderPace } from '@extension/storage';

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
 * task) or `teleport` — it reappears at the exact viewport spot it left on
 * the previous page or tab, so it reads as the same spider moving on.
 */
export type SpiderArrival = 'descend' | 'teleport';

/** Where the spider was and which way it faced, carried across pages. */
export interface SpiderPlace {
  x: number;
  y: number;
  heading: number;
}

export type SpiderCommand =
  | { op: 'spawn'; look: SpiderLook; at?: SpiderPlace; arrive?: SpiderArrival }
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
  /** Collapse into a point before a navigation or a tab switch; resolves when gone. */
  | { op: 'depart' }
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
}

export interface SpiderHelloReply {
  active: boolean;
  look?: SpiderLook;
  at?: SpiderPlace;
  arrive?: SpiderArrival;
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
