/**
 * Background side of the agent spider ("the handles"): commands for the
 * spider the content script draws in the agent's tab. `Page` calls these
 * around real actions — walk to the element and tap it, then click; drum
 * while typing; clear the canvas before a screenshot; collapse before a
 * navigation.
 *
 * There is one spider per task. It lives in the *current* tab — the last
 * one the agent attached to or acted in. When the agent moves to another
 * tab or page, the spider collapses where it was and reappears at the same
 * spot there (a teleport), instead of a second spider descending again.
 *
 * Every call is bounded and swallows its own errors: the spider is
 * decoration, and a missing content script, a chrome:// page or a closed
 * tab must never fail or noticeably slow an agent action.
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
  SpiderPlace,
  SpiderPoint,
  SpiderRect,
} from '@extension/shared';
import { createLogger } from '@src/background/log';

const logger = createLogger('Spider');

export const SPIDER_CONTENT_SCRIPT = 'content/index.iife.js';

/** Approach cap at normal pace; the flight itself takes about half a second. */
const APPROACH_CAP_MS = 900;
const PACE_FACTOR = { calm: 1.35, normal: 1, fast: 0.7 } as const;

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

export class SpiderBridge {
  private settings: SpiderSettings = DEFAULT_SPIDER_SETTINGS;
  private loading: Promise<void> | null = null;
  private readonly active = new Set<number>();
  private readonly lastInject = new Map<number, number>();
  /** Tab the spider lives in now. */
  private current: number | null = null;
  /** Where it was last seen, carried across pages and tabs. */
  private place: SpiderPlace | null = null;
  /** Already shown in this task: further entrances are teleports, not descents. */
  private shown = false;

  constructor(
    private readonly transport: SpiderTransport = chromeTransport,
    private readonly source: SpiderSettingsSource = spiderSettingsStore,
  ) {}

  /** Agent attached to this tab: the spider comes here. */
  async activate(tabId: number): Promise<void> {
    await this.load();
    if (!this.settings.enabled) return;
    this.active.add(tabId);
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
      await this.send(tabId, { op: 'leave' }, 300);
    }
    if (this.active.size === 0) {
      this.shown = false;
      this.place = null;
    }
  }

  /** Tab closed. */
  forget(tabId: number): void {
    this.active.delete(tabId);
    this.lastInject.delete(tabId);
    if (this.current === tabId) this.current = null;
    if (this.active.size === 0) {
      this.shown = false;
      this.place = null;
    }
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
    };
    this.shown = true;
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

  async typing(tabId: number, on: boolean): Promise<void> {
    if (!this.isOn(tabId)) return;
    if (on) await this.moveTo(tabId);
    await this.send(tabId, { op: 'typing', on }, 200);
  }

  scroll(tabId: number, dy: number): void {
    if (!this.isOn(tabId) || this.current !== tabId) return;
    void this.send(tabId, { op: 'scroll', dy }, 200);
  }

  /** The agent navigates this tab: collapse first, so the next page reads as the spider arriving. */
  async depart(tabId: number): Promise<void> {
    if (!this.isOn(tabId) || this.current !== tabId) return;
    await this.send(tabId, { op: 'depart' }, 350);
    const at = this.place ? `${Math.round(this.place.x)},${Math.round(this.place.y)}` : '-';
    logger.info(`depart tab=${tabId} at=${at}`);
  }

  /** Clear the spider off the canvas before a screenshot of the page. */
  async hide(tabId: number): Promise<void> {
    if (!this.isOn(tabId) || this.current !== tabId) return;
    await this.send(tabId, { op: 'hide' }, 300);
  }

  async show(tabId: number): Promise<void> {
    if (!this.isOn(tabId) || this.current !== tabId) return;
    await this.send(tabId, { op: 'show' }, 200);
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
        ack = await this.sendOnce(tabId, cmd, Math.max(50, deadline - Date.now()));
      }
      if (ack?.pose && ack.visible && tabId === this.current) {
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
  }

  private spawnCmd(): SpiderCommand {
    return {
      op: 'spawn',
      look: this.look(),
      at: this.place ?? undefined,
      arrive: this.shown ? 'teleport' : 'descend',
    };
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
    const { size, pace, marks } = this.settings;
    return { size, pace, marks };
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
    else if (!wasOn && next.enabled) void this.send(tabId, this.spawnCmd(), 300);
    else if (next.enabled) void this.send(tabId, { op: 'tune', look: this.look() }, 300);
  }
}

const toRect = (r: SpiderRect): SpiderRect => ({ x: r.x, y: r.y, width: r.width, height: r.height });

const isPlace = (p: SpiderPlace): boolean =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.heading);

export const spiderBridge = new SpiderBridge();
