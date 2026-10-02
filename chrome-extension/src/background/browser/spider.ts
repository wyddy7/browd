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
 */
import {
  DEFAULT_SPIDER_SETTINGS,
  normalizeSpiderSettings,
  spiderSettingsStore,
  type SpiderSettings,
} from '@extension/storage';
import type {
  SpiderAck,
  SpiderCommand,
  SpiderHelloReply,
  SpiderMessage,
  SpiderMood,
  SpiderPlace,
  SpiderPoint,
  SpiderRect,
} from '@extension/shared';
import { createLogger } from '@src/background/log';
import { type AgentEventLike, focusWords, moodOf, planTexts } from './agentMood';
import type { PagePresence } from './presence';

const logger = createLogger('Spider');

export const SPIDER_CONTENT_SCRIPT = 'content/index.iife.js';

/** Approach cap at normal pace; the flight itself takes about half a second. */
const APPROACH_CAP_MS = 900;
const PACE_FACTOR = { calm: 1.35, normal: 1, fast: 0.7 } as const;
/** Pose modes in which the spider stands on the page (its place is worth carrying over). */
const GROUNDED = /^(idle|busy|approach)/;

export interface SpiderTransport {
  send(tabId: number, msg: SpiderMessage): Promise<SpiderAck | undefined>;
  inject(tabId: number): Promise<void>;
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

  scrolled(tabId: number, dy: number): void {
    if (!this.isOn(tabId) || this.current !== tabId) return;
    void this.send(tabId, { op: 'scroll', dy }, 200);
  }

  async beforeNavigate(tabId: number): Promise<void> {
    await this.depart(tabId);
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
    await this.send(tabId, { op: 'typing', on }, 200);
  }

  // ---------- agent state ----------

  /** The task the agent starts on: the first source of focus words. */
  setTask(text: string): void {
    this.taskText = text;
    this.focus = focusWords([text]);
  }

  /** Every execution event of the agent. Cheap: most events change nothing and send nothing. */
  async onAgentEvent(event: AgentEventLike): Promise<void> {
    const plan = planTexts(event);
    if (plan) this.focus = focusWords([...plan.slice(0, 1), this.taskText]);
    const mood = moodOf(event);
    if (mood) this.mood = mood;
    const tabId = this.current;
    if (tabId === null || !this.isOn(tabId)) return;
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
    if (this.current === tabId) {
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
    const reply: SpiderHelloReply = {
      active: true,
      look: this.look(),
      at: this.place ?? undefined,
      arrive: this.shown ? 'teleport' : 'descend',
      mood: this.mood ?? undefined,
      focus: this.focus,
    };
    this.shown = true;
    this.markSent();
    return reply;
  }

  /** The page in this tab is unloading; remember where the spider was. */
  reportPlace(tabId: number | undefined, place: SpiderPlace): void {
    if (tabId === undefined || tabId !== this.current || !isPlace(place)) return;
    this.place = place;
    logger.info(`unload tab=${tabId} at=${Math.round(place.x)},${Math.round(place.y)}`);
  }

  /** Walk to `point` and tap it; resolves at the moment of contact or after the cap. */
  async strikeAt(tabId: number, point: SpiderPoint, rect?: SpiderRect): Promise<SpiderAck | null> {
    if (!this.isOn(tabId)) return null;
    await this.moveTo(tabId);
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

  async send(tabId: number, cmd: SpiderCommand, capMs: number): Promise<SpiderAck | null> {
    const deadline = Date.now() + capMs;
    try {
      let ack = await this.sendOnce(tabId, cmd, capMs);
      if (
        ack?.reason === 'not-spawned' &&
        cmd.op !== 'spawn' &&
        cmd.op !== 'leave' &&
        cmd.op !== 'depart' &&
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
        this.place = { x: ack.pose.body.x, y: ack.pose.body.y, heading: ack.pose.heading };
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
    const prev = this.current;
    this.current = tabId;
    if (prev !== null && this.active.has(prev)) {
      await this.send(prev, { op: 'depart' }, 350);
    }
    logger.info(`move tab=${prev ?? '-'}→${tabId} arrive=${this.shown ? 'teleport' : 'descend'}`);
    await this.send(tabId, this.spawnCmd(), 400);
    this.shown = true;
    this.markSent();
  }

  private spawnCmd(): SpiderCommand {
    return {
      op: 'spawn',
      look: this.look(),
      at: this.place ?? undefined,
      arrive: this.shown ? 'teleport' : 'descend',
      mood: this.mood ?? undefined,
      focus: this.focus,
    };
  }

  /** The spawn just carried the current mood and focus. */
  private markSent(): void {
    this.sentMood = this.mood;
    this.sentFocus = this.focus.join(' ');
  }

  private resetTask(): void {
    this.shown = false;
    this.place = null;
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
      if (!NO_RECEIVER.test(text) || cmd.op === 'leave' || cmd.op === 'show' || cmd.op === 'depart') throw error;
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
    if (wasOn && !next.enabled) void this.send(tabId, { op: 'leave' }, 300);
    else if (!wasOn && next.enabled) {
      void this.send(tabId, this.spawnCmd(), 300);
      this.markSent();
    } else if (next.enabled) void this.send(tabId, { op: 'tune', look: this.look() }, 300);
  }
}

const toRect = (r: SpiderRect): SpiderRect => ({ x: r.x, y: r.y, width: r.width, height: r.height });

const isPlace = (p: SpiderPlace): boolean =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.heading);

export const spiderBridge = new SpiderBridge();
