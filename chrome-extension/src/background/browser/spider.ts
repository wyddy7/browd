/**
 * Background side of the agent spider. Two inputs, one place each:
 *
 * - `PagePresence` (see `presence.ts`): `Page` reports its choke points —
 *   a pointer action is about to land, keys are typed, a capture, a
 *   navigation, attach/detach. The spider walks there and taps, drums,
 *   hides, collapses.
 * - `onAgentEvent`: every execution event of the agent, from the single
 *   subscription in `background/index.ts`. It becomes a mood (thinking,
 *   acting, waiting, asking, done, failed) and the focus words — what the
 *   task and the current subgoal are about — sent only when they change.
 *
 * There is one spider per task. It lives in the *current* tab — the last one
 * the agent attached to or acted in — and teleports when the agent moves to
 * another tab or page. Every call is bounded and swallows its own errors.
 *
 * During a long burst of navigations it does not stay on pages that keep
 * being replaced: it waits in the chat panel (see `side-panel/src/spiderPanel.ts`)
 * and comes back on the agent's next click or typing, or after `QUIET_MS`
 * without a navigation. A burst is the `BURST_COUNT`-th navigation within
 * `BURST_MS`, or — predicted — the first one when the task and the plan name
 * `PLANNED_SITES` or more sites. One or two quick hops stay on the pages.
 *
 * There is never more than one spider on screen: `seat` is the single place it
 * is, and a move between page and panel is sequenced — the leaving one is gone
 * before the other appears. After a link-click navigation the panel waits for
 * the next page's first paint, so the browser's held frame of the old page
 * (spider included) is off screen first.
 */
import {
  DEFAULT_SPIDER_SETTINGS,
  normalizeSpiderSettings,
  spiderSettingsStore,
  type SpiderSettings,
} from '@extension/storage';
import type {
  SpiderAck,
  SpiderArrival,
  SpiderCommand,
  SpiderCrossPlan,
  SpiderHelloReply,
  SpiderMessage,
  SpiderMood,
  SpiderPanelMessage,
  SpiderPlace,
  SpiderPoint,
  SpiderRect,
} from '@extension/shared';
import { createLogger } from '@src/background/log';
import { type AgentEventLike, focusWords, moodOf, planTexts } from './agentMood';
import { type Portal, portal } from './portal';
import type { PagePresence } from './presence';

const logger = createLogger('Spider');

export const SPIDER_CONTENT_SCRIPT = 'content/index.iife.js';

/** Approach cap at normal pace; the flight itself takes about half a second. */
const APPROACH_CAP_MS = 900;
const PACE_FACTOR = { calm: 1.35, normal: 1, fast: 0.7 } as const;
/** Pose modes in which the spider stands on the page (its place is worth carrying over). */
const GROUNDED = /^(idle|busy|approach)/;
/** This many navigations within `BURST_MS` are a burst: the spider waits in the chat panel. */
const BURST_COUNT = 3;
const BURST_MS = 12000;
/** A task and plan naming this many distinct sites predict a burst: the chat from the first navigation. */
const PLANNED_SITES = 3;
/** In the chat this long with no navigation, it goes back to the page even without a click. */
const QUIET_MS = 8000;
/** After a link-click navigation the panel waits for the next page's paint, at most this long. */
const PANEL_ENTRY_FALLBACK_MS = 2500;
/** The leap across the seam between the page and the chat panel, ms. */
const CROSS_MS = 650;

/** Where the one spider is: on the current page, in the chat panel, or moving between them. */
type Seat = 'page' | 'toPanel' | 'panel' | 'toPage';

/** Distinct sites named in some texts (hostnames, `www.` dropped). */
export function sitesIn(texts: string[]): number {
  const hosts = new Set<string>();
  const re = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,24})\b/gi;
  for (const t of texts) for (const m of t.matchAll(re)) hosts.add(m[1].toLowerCase().replace(/^www\./, ''));
  return hosts.size;
}

export interface SpiderTransport {
  send(tabId: number, msg: SpiderMessage): Promise<SpiderAck | undefined>;
  inject(tabId: number): Promise<void>;
  /** The chat panel (side panel page); undefined or a throw when it is not open. */
  panel?(msg: SpiderPanelMessage): Promise<SpiderAck | undefined>;
  /** The tab's page zoom (1 = 100 %). */
  zoom?(tabId: number): Promise<number>;
}

export interface SpiderSettingsSource {
  getSettings(): Promise<SpiderSettings>;
  subscribe(listener: () => void): () => void;
}

const chromeTransport: SpiderTransport = {
  send: (tabId, msg) => chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }) as Promise<SpiderAck | undefined>,
  inject: async tabId => {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [SPIDER_CONTENT_SCRIPT] });
  },
  panel: msg => chrome.runtime.sendMessage(msg) as Promise<SpiderAck | undefined>,
  zoom: tabId => chrome.tabs.getZoom(tabId),
};

const NO_RECEIVER = /Receiving end does not exist|Could not establish connection/i;

function withCap<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]);
}

export class SpiderBridge implements PagePresence {
  private settings: SpiderSettings = DEFAULT_SPIDER_SETTINGS;
  private loading: Promise<void> | null = null;
  private readonly active = new Set<number>();
  private readonly lastInject = new Map<number, number>();
  /** Tab the spider lives in now. */
  private current: number | null = null;
  /** Where it was last seen standing, carried across pages and tabs. */
  private place: SpiderPlace | null = null;
  /** The tab whose page is being replaced (navigation): its next page gets a handoff, not a teleport. */
  private handoffTab: number | null = null;
  private handoffAt = 0;
  private seat: Seat = 'page';
  /** The chat panel is open (its port is connected); a running task implies it. */
  private panelOpen = false;
  private panelEntryTimer: ReturnType<typeof setTimeout> | null = null;
  private navs: number[] = [];
  private lastNavAt = 0;
  private plannedSites = 0;
  /** The plan's prediction is used once per task: later hops back and forth would ping-pong the spider. */
  private plannedUsed = false;
  /** Already shown in this task: further entrances are teleports, not descents. */
  private shown = false;
  private mood: SpiderMood | null = null;
  private sentMood: SpiderMood | null = null;
  private taskText = '';
  private focus: string[] = [];
  private sentFocus = '';

  constructor(
    private readonly transport: SpiderTransport = chromeTransport,
    private readonly source: SpiderSettingsSource = spiderSettingsStore,
  ) {}

  // ---------- PagePresence ----------

  showing(tabId: number): boolean {
    return this.isOn(tabId);
  }

  attached(tabId: number): void {
    void this.activate(tabId);
  }

  detached(tabId: number): void {
    void this.deactivate(tabId);
  }

  async beforePointer(tabId: number, point: SpiderPoint, rect?: SpiderRect): Promise<void> {
    await this.strikeAt(tabId, point, rect);
  }

  async scanning(tabId: number, on: boolean): Promise<void> {
    if (!this.isOn(tabId) || this.current !== tabId) return;
    // Sent before the DOM build blocks the page's thread, so the spider is already still.
    await this.send(tabId, { op: 'scan', on }, on ? 150 : 100);
  }

  scrolled(tabId: number, dy: number): void {
    if (!this.isOn(tabId) || this.current !== tabId) return;
    void this.send(tabId, { op: 'scroll', dy }, 200);
  }

  async beforeNavigate(tabId: number): Promise<void> {
    // A page is about to load: the spider stands still (no collapse) and the next page of
    // this tab draws it on the same spot with the same legs — a handoff, not an entrance.
    this.mood = 'waiting';
    this.sentMood = 'waiting';
    if (!this.isOn(tabId) || this.current !== tabId) return;
    if (await this.noteNavigation(tabId, 'hook')) return;
    const ack = await this.send(tabId, { op: 'handoff' }, 150);
    if (ack?.place && isPlace(ack.place)) this.place = ack.place;
    this.markHandoff(tabId);
    const at = this.place ? `${Math.round(this.place.x)},${Math.round(this.place.y)}` : '-';
    logger.info(`handoff tab=${tabId} at=${at}`);
  }

  async beforeCapture(tabId: number): Promise<void> {
    if (!this.isOn(tabId) || this.current !== tabId) return;
    await this.send(tabId, { op: 'hide' }, 300);
  }

  afterCapture(tabId: number): void {
    if (!this.isOn(tabId) || this.current !== tabId) return;
    void this.send(tabId, { op: 'show' }, 200);
  }

  async typing(tabId: number, on: boolean): Promise<void> {
    if (!this.isOn(tabId)) return;
    if (on) await this.moveTo(tabId);
    if (on) await this.toPage(tabId);
    await this.send(tabId, { op: 'typing', on }, 200);
  }

  // ---------- agent state ----------

  /** The task the agent starts on: the first source of focus words. */
  setTask(text: string): void {
    this.taskText = text;
    this.focus = focusWords([text]);
    this.plannedSites = sitesIn([text]);
  }

  /** Every execution event of the agent. Cheap: most events change nothing and send nothing. */
  async onAgentEvent(event: AgentEventLike): Promise<void> {
    const plan = planTexts(event);
    if (plan) {
      this.focus = focusWords([...plan.slice(0, 1), this.taskText]);
      this.plannedSites = sitesIn([this.taskText, ...plan]);
    }
    const mood = moodOf(event);
    if (mood) this.mood = mood;
    const tabId = this.current;
    if (tabId === null || !this.isOn(tabId)) return;
    if (this.seat === 'panel') {
      // The burst is over when no navigation came for a while: back to the page.
      if (Date.now() - this.lastNavAt > QUIET_MS) await this.toPage(tabId);
      else if (this.mood && this.mood !== this.sentMood) {
        this.sentMood = this.mood;
        void this.panelSend({ op: 'mood', mood: this.mood }, 200);
      }
      return;
    }
    if (this.seat !== 'page') return;
    await this.flushState(tabId);
  }

  /** Send mood and focus if they changed since the last send. */
  private async flushState(tabId: number): Promise<void> {
    const focusKey = this.focus.join(' ');
    if (focusKey !== this.sentFocus) {
      this.sentFocus = focusKey;
      await this.send(tabId, { op: 'focus', words: this.focus }, 200);
    }
    if (this.mood && this.mood !== this.sentMood) {
      this.sentMood = this.mood;
      await this.send(tabId, { op: 'mood', mood: this.mood }, 200);
    }
  }

  // ---------- lifecycle ----------

  /** Agent attached to this tab: the spider comes here. */
  async activate(tabId: number): Promise<void> {
    await this.load();
    this.active.add(tabId);
    if (!this.settings.enabled) {
      // Hidden: still track the agent's tab, so turning the spider on mid-task brings it here.
      this.current = tabId;
      return;
    }
    if (this.seat !== 'page') {
      this.current = tabId;
      return;
    }
    if (this.current === tabId) {
      await this.send(tabId, this.spawnCmd(), 400);
      this.shown = true;
      return;
    }
    await this.moveTo(tabId);
  }

  /** Agent detached: from the current tab the spider climbs away; the task is over when no tab is left. */
  async deactivate(tabId: number): Promise<void> {
    if (!this.active.delete(tabId)) return;
    if (this.current === tabId && this.seat !== 'page') {
      // The task ended while the spider waited in the chat: it says goodbye from there.
      this.current = null;
      this.settleSeat();
      void this.panelSend({ op: 'leave', mood: this.mood ?? undefined }, 300);
    } else if (this.current === tabId) {
      this.current = null;
      if (this.settings.enabled) {
        // The ending mood (done / failed) goes first, so the gesture plays before the climb.
        if (this.mood && this.mood !== this.sentMood) await this.send(tabId, { op: 'mood', mood: this.mood }, 200);
        await this.send(tabId, { op: 'leave' }, 300);
      }
    }
    if (this.active.size === 0) this.resetTask();
  }

  /** Tab closed. */
  forget(tabId: number): void {
    this.active.delete(tabId);
    this.lastInject.delete(tabId);
    if (this.current === tabId) this.current = null;
    if (this.active.size === 0) this.resetTask();
  }

  isOn(tabId: number): boolean {
    return this.settings.enabled && this.active.has(tabId);
  }

  /** Answer to the content script's hello after a page load in this tab. */
  helloReply(tabId: number | undefined): SpiderHelloReply {
    if (tabId === undefined || !this.isOn(tabId) || this.current !== tabId) return { active: false };
    // In (or on its way to) the chat: this page stays empty and only reports its first paint.
    if (this.seat !== 'page') return { active: false, parked: true };
    const reply: SpiderHelloReply = {
      active: true,
      look: this.look(),
      at: this.place ?? undefined,
      arrive: this.arrival(tabId),
      mood: this.mood ?? undefined,
      focus: this.focus,
    };
    if (reply.arrive === 'handoff') this.handoffTab = null; // one page gets it
    this.shown = true;
    this.markSent();
    return reply;
  }

  /** The page in this tab is unloading; remember where the spider was. */
  reportPlace(tabId: number | undefined, place: SpiderPlace): void {
    if (tabId === undefined || tabId !== this.current || !isPlace(place)) return;
    this.place = place;
    this.markHandoff(tabId);
    void this.noteNavigation(tabId, 'unload');
    logger.info(`unload tab=${tabId} at=${Math.round(place.x)},${Math.round(place.y)}`);
  }

  /** Walk to `point` and tap it; resolves at the moment of contact or after the cap. */
  async strikeAt(tabId: number, point: SpiderPoint, rect?: SpiderRect): Promise<SpiderAck | null> {
    if (!this.isOn(tabId)) return null;
    await this.moveTo(tabId);
    await this.toPage(tabId);
    const capMs = Math.round(APPROACH_CAP_MS * PACE_FACTOR[this.settings.pace]);
    const t0 = Date.now();
    const approach = await this.send(tabId, { op: 'approach', point, rect: rect && toRect(rect), capMs }, capMs + 250);
    const strike = await this.send(tabId, { op: 'strike', point, rect: rect && toRect(rect) }, 350);
    // One line per action: whether the spider was really there, and what it cost.
    logger.info(
      `strike tab=${tabId} at=${Math.round(point.x)},${Math.round(point.y)} arrived=${approach?.arrived ?? 'no-answer'}` +
        `${approach?.reason ? ` reason=${approach.reason}` : ''} struck=${strike?.ok ?? false} ms=${Date.now() - t0}`,
    );
    return strike;
  }

  /** The agent navigates this tab: collapse first, so the next page reads as the spider arriving. */
  async depart(tabId: number): Promise<void> {
    if (!this.isOn(tabId) || this.current !== tabId) return;
    await this.send(tabId, { op: 'depart' }, 350);
    const at = this.place ? `${Math.round(this.place.x)},${Math.round(this.place.y)}` : '-';
    logger.info(`depart tab=${tabId} at=${at}`);
  }

  /**
   * `seatMove`: part of a move between page and panel. Otherwise, while the
   * spider is not on the page, pages get nothing — no spawn can sneak in.
   */
  async send(tabId: number, cmd: SpiderCommand, capMs: number, seatMove = false): Promise<SpiderAck | null> {
    if (this.seat !== 'page' && !seatMove) return null;
    const deadline = Date.now() + capMs;
    try {
      let ack = await this.sendOnce(tabId, cmd, capMs);
      if (
        ack?.reason === 'not-spawned' &&
        cmd.op !== 'spawn' &&
        cmd.op !== 'leave' &&
        cmd.op !== 'depart' &&
        cmd.op !== 'handoff' &&
        cmd.op !== 'exit' &&
        this.current === tabId
      ) {
        // A page that loaded after the hello raced, or a fresh injection.
        await this.sendOnce(tabId, this.spawnCmd(), 200);
        this.shown = true;
        this.markSent();
        ack = await this.sendOnce(tabId, cmd, Math.max(50, deadline - Date.now()));
      }
      // Only a spider standing on the page gives a place worth carrying over
      // (not one still on its thread at y = -80, nor one mid-teleport).
      if (ack?.pose && ack.visible && tabId === this.current && GROUNDED.test(ack.pose.mode)) {
        // Keep the legs of the last full place (handoff, unload) if the body has not moved since.
        const same = this.place && Math.hypot(this.place.x - ack.pose.body.x, this.place.y - ack.pose.body.y) < 1;
        this.place =
          same && this.place ? this.place : { x: ack.pose.body.x, y: ack.pose.body.y, heading: ack.pose.heading };
      }
      return ack;
    } catch (error) {
      logger.debug(`spider ${cmd.op} on tab ${tabId} skipped`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  /** The spider goes to `tabId`: it collapses in the tab it was in and reappears here. */
  private async moveTo(tabId: number): Promise<void> {
    if (this.current === tabId) return;
    if (this.seat !== 'page') {
      // It comes back from the chat straight into the new tab (see toPage).
      this.current = tabId;
      return;
    }
    const prev = this.current;
    this.current = tabId;
    if (prev !== null && this.active.has(prev)) {
      await this.send(prev, { op: 'depart' }, 350);
    }
    logger.info(`move tab=${prev ?? '-'}→${tabId} arrive=${this.arrival(tabId)}`);
    await this.send(tabId, this.spawnCmd(), 400);
    this.shown = true;
    this.markSent();
  }

  /** The chat panel opened or closed (its port). Closing it cancels the task anyway. */
  setPanelOpen(open: boolean): void {
    this.panelOpen = open;
  }

  /** A page told `parked` has painted: the old page is off screen, the panel may show the spider. */
  pagePainted(tabId: number | undefined): void {
    if (this.seat === 'toPanel' && tabId === this.current) void this.enterPanel();
  }

  /**
   * A navigation of the current tab begins: go_to_url's hook (the old page can
   * still show the leap out) or the page unloading (a link click). Returns
   * whether the spider is (going) in the chat now.
   */
  private async noteNavigation(tabId: number, how: 'hook' | 'unload'): Promise<boolean> {
    const now = Date.now();
    // One navigation reported twice: the hook before it, then the page's unload.
    const repeat = now - this.lastNavAt < 1500;
    this.lastNavAt = now;
    if (repeat || this.seat !== 'page') return this.seat !== 'page';
    this.navs = [...this.navs.filter(t => now - t < BURST_MS), now];
    const planned = !this.plannedUsed && this.plannedSites >= PLANNED_SITES;
    if (!this.panelOpen || (!planned && this.navs.length < BURST_COUNT)) return false;
    if (planned) this.plannedUsed = true;
    logger.info(
      `park tab=${tabId} (${planned ? `planned: ${this.plannedSites} sites` : `${this.navs.length} navigations`})`,
    );
    this.seat = 'toPanel';
    if (how === 'hook') {
      // Across the seam if both sides can be measured: one spider, half on each side.
      if (await this.crossToPanel(tabId)) return true;
      // Otherwise out of the page first, then into the panel: never two on screen.
      await this.send(tabId, { op: 'exit', side: 'right' }, 800, true);
      logger.info(`park tab=${tabId} out of the page`);
      await this.enterPanel();
    } else {
      // The page is going away; the panel waits until the next page has painted over it.
      void this.send(tabId, { op: 'exit', side: 'right' }, 800, true);
      this.panelEntryTimer = setTimeout(() => void this.enterPanel(), PANEL_ENTRY_FALLBACK_MS);
    }
    return true;
  }

  /** The spider lands in the chat panel (the page side is already empty). */
  private async enterPanel(): Promise<void> {
    if (this.seat !== 'toPanel') return;
    this.clearPanelTimer();
    const ack = await this.panelSend({ op: 'park', look: this.look(), mood: this.mood ?? undefined }, 300);
    if (this.seat !== 'toPanel') return;
    if (ack?.ok) {
      this.seat = 'panel';
      this.sentMood = this.mood;
      return;
    }
    // The panel did not take it: back onto the page.
    logger.info('park refused by the panel; back to the page');
    this.seat = 'toPage';
    await this.landOnPage();
  }

  /** Back from the chat: it leaves the panel (gone first), then leaps into the page from its right edge. */
  private async toPage(tabId: number): Promise<void> {
    if (this.seat === 'page' || this.seat === 'toPage') return;
    const fromPanel = this.seat === 'panel';
    this.seat = 'toPage';
    this.clearPanelTimer();
    this.navs = [];
    logger.info(`unpark tab=${tabId}`);
    if (fromPanel && (await this.crossToPage(tabId))) return;
    if (fromPanel) await this.panelSend({ op: 'unpark' }, 800);
    logger.info(`unpark tab=${tabId} out of the panel`);
    await this.landOnPage();
  }

  /** The seam between this tab's page and the chat panel, measured now; null if either side does not answer. */
  private async portalFor(
    tabId: number,
  ): Promise<{
    map: Portal;
    panelW: number;
    panelH: number;
    pageW: number;
    pageH: number;
    side: 'left' | 'right';
  } | null> {
    if (!this.transport.zoom) return null;
    const [pageAck, panelAck, zoom] = await Promise.all([
      this.send(tabId, { op: 'metrics' }, 200, true),
      this.panelSend({ op: 'metrics' }, 200),
      withCap(this.transport.zoom(tabId), 200).catch(() => null),
    ]);
    const pg = pageAck?.metrics;
    const pn = panelAck?.metrics;
    if (!pg || !pn || !zoom || !(pg.width > 0) || !(pn.width > 0)) return null;
    const side = pn.side ?? 'right';
    return {
      map: portal({ ...pg, zoom }, pn, side),
      panelW: pn.width,
      panelH: pn.height,
      pageW: pg.width,
      pageH: pg.height,
      side,
    };
  }

  /**
   * Page → panel across the seam: the page spider glides to the panel's seat
   * (beyond its own edge) and the panel draws the same glide in its own
   * coordinates. Returns once the page half is out of view (the navigation
   * may go on then), false if the seam could not be measured.
   */
  private async crossToPanel(tabId: number): Promise<boolean> {
    const seam = await this.portalFor(tabId);
    if (!seam) return false;
    const seat = { x: seam.side === 'right' ? 96 : seam.panelW - 96, y: Math.round(seam.panelH * 0.62) };
    const out = await this.send(
      tabId,
      { op: 'crossOut', to: seam.map.toPage(seat), T: CROSS_MS, bow: 0.04 },
      250,
      true,
    );
    if (!out?.cross) return false;
    const plan = mapPlan(out.cross.plan, seam.map.toPanel, seam.map.k);
    const ack = await this.panelSend({ op: 'crossIn', plan, look: this.look(), mood: this.mood ?? undefined }, 300);
    logger.info(`park tab=${tabId} across the seam k=${seam.map.k.toFixed(2)} margin=${seam.map.margin.toFixed(1)}`);
    await sleepUntil(out.cross.clearAt);
    if (ack?.ok) {
      this.seat = 'panel';
      this.sentMood = this.mood;
    } else {
      // The panel did not take it; the page half has left — back onto the page.
      this.seat = 'toPage';
      await this.landOnPage();
    }
    return true;
  }

  /** Panel → page across the seam; returns once the panel half is out of view (the page spider may turn then). */
  private async crossToPage(tabId: number): Promise<boolean> {
    const seam = await this.portalFor(tabId);
    if (!seam) return false;
    const land = {
      x: seam.side === 'right' ? seam.pageW - 120 : 120,
      y: Math.min(seam.pageH - 80, Math.max(80, this.place?.y ?? seam.pageH / 2)),
    };
    const out = await this.panelSend({ op: 'crossOut', to: seam.map.toPanel(land), T: CROSS_MS, bow: 0.04 }, 250);
    if (!out?.cross) return false;
    const plan = mapPlan(out.cross.plan, seam.map.toPage, 1 / seam.map.k);
    const cmd: SpiderCommand = {
      op: 'crossIn',
      plan,
      look: this.look(),
      mood: this.mood ?? undefined,
      focus: this.focus,
    };
    await this.send(tabId, cmd, 300, true);
    logger.info(`unpark tab=${tabId} across the seam`);
    await sleepUntil(out.cross.clearAt);
    this.shown = true;
    this.markSent();
    this.seat = 'page';
    return true;
  }

  private async landOnPage(): Promise<void> {
    const tabId = this.current;
    if (tabId !== null && this.settings.enabled) {
      const cmd: SpiderCommand = {
        op: 'spawn',
        look: this.look(),
        at: { x: 100000, y: this.place?.y ?? 360, heading: Math.PI },
        arrive: 'edge',
        mood: this.mood ?? undefined,
        focus: this.focus,
      };
      await this.send(tabId, cmd, 400, true);
      this.shown = true;
      this.markSent();
    }
    this.seat = 'page';
  }

  /** Forget a move between page and panel (task over, spider off). */
  private settleSeat(): void {
    this.seat = 'page';
    this.navs = [];
    this.clearPanelTimer();
  }

  private clearPanelTimer(): void {
    if (this.panelEntryTimer) clearTimeout(this.panelEntryTimer);
    this.panelEntryTimer = null;
  }

  private async panelSend(msg: Omit<SpiderPanelMessage, 'type'>, capMs: number): Promise<SpiderAck | null> {
    if (!this.transport.panel) return null;
    try {
      return (await withCap(this.transport.panel({ type: 'browd:spider:panel', ...msg }), capMs)) ?? null;
    } catch {
      // No chat panel open.
      return null;
    }
  }

  private spawnCmd(arrive?: SpiderArrival): SpiderCommand {
    const how = arrive ?? (this.current === null ? 'teleport' : this.arrival(this.current));
    if (how === 'handoff') this.handoffTab = null; // one page gets it
    return {
      op: 'spawn',
      look: this.look(),
      at: this.place ?? undefined,
      arrive: how,
      mood: this.mood ?? undefined,
      focus: this.focus,
    };
  }

  /**
   * How the spider enters a page of `tabId`: a descent the first time in a
   * task; a handoff on the next page of the tab it was just standing in (it
   * stands on with no entrance); a teleport anywhere else (another tab).
   */
  private arrival(tabId: number): SpiderArrival {
    if (!this.shown) return 'descend';
    return this.handoffTab === tabId && Date.now() - this.handoffAt < 15000 ? 'handoff' : 'teleport';
  }

  private markHandoff(tabId: number): void {
    this.handoffTab = tabId;
    this.handoffAt = Date.now();
  }

  /** The spawn just carried the current mood and focus. */
  private markSent(): void {
    this.sentMood = this.mood;
    this.sentFocus = this.focus.join(' ');
  }

  private resetTask(): void {
    this.shown = false;
    this.place = null;
    this.handoffTab = null;
    this.settleSeat();
    this.lastNavAt = 0;
    this.plannedSites = 0;
    this.plannedUsed = false;
    this.mood = null;
    this.sentMood = null;
    this.sentFocus = '';
  }

  private async sendOnce(tabId: number, cmd: SpiderCommand, capMs: number): Promise<SpiderAck | null> {
    const msg: SpiderMessage = { type: 'browd:spider', cmd };
    try {
      return (await withCap(this.transport.send(tabId, msg), capMs)) ?? null;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (
        !NO_RECEIVER.test(text) ||
        cmd.op === 'leave' ||
        cmd.op === 'show' ||
        cmd.op === 'depart' ||
        cmd.op === 'handoff' ||
        cmd.op === 'exit'
      )
        throw error;
      // Tab was open before the extension loaded: no content script yet.
      const last = this.lastInject.get(tabId) ?? 0;
      if (Date.now() - last < 3000) throw error;
      this.lastInject.set(tabId, Date.now());
      await withCap(this.transport.inject(tabId), 500);
      return (await withCap(this.transport.send(tabId, msg), capMs)) ?? null;
    }
  }

  private look() {
    const { size, pace, marks, color, tear } = this.settings;
    return { size, pace, marks, color, tear };
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        this.settings = normalizeSpiderSettings(await this.source.getSettings());
        this.source.subscribe(() => void this.reload());
      } catch (error) {
        logger.debug('spider settings unavailable, using defaults', error instanceof Error ? error.message : '');
      }
    })();
    return this.loading;
  }

  private async reload(): Promise<void> {
    const next = normalizeSpiderSettings(await this.source.getSettings());
    const wasOn = this.settings.enabled;
    this.settings = next;
    const tabId = this.current;
    if (tabId === null) return;
    if (wasOn && !next.enabled && this.seat !== 'page') {
      this.settleSeat();
      void this.panelSend({ op: 'leave' }, 300);
    } else if (wasOn && !next.enabled) void this.send(tabId, { op: 'leave' }, 300);
    else if (!wasOn && next.enabled) {
      // Switched on from the chat: an entrance, not a silent handoff.
      void this.send(tabId, this.spawnCmd(this.shown ? 'teleport' : 'descend'), 300);
      this.markSent();
    } else if (next.enabled) void this.send(tabId, { op: 'tune', look: this.look() }, 300);
  }
}

const toRect = (r: SpiderRect): SpiderRect => ({ x: r.x, y: r.y, width: r.width, height: r.height });

/** A crossing plan seen from the other document: points mapped, velocity and size scaled. */
function mapPlan(p: SpiderCrossPlan, map: (q: SpiderPoint) => SpiderPoint, k: number): SpiderCrossPlan {
  return { ...p, from: map(p.from), to: map(p.to), v0: { x: p.v0.x * k, y: p.v0.y * k }, size: p.size * k };
}

const sleepUntil = (epochMs: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(1500, epochMs - Date.now()))));

const isPlace = (p: SpiderPlace): boolean =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.heading);

export const spiderBridge = new SpiderBridge();
