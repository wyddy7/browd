/**
 * Background side of the agent spider ("the handles"): commands for the
 * spider the content script draws in the agent's tab. `Page` calls these
 * around real actions — walk to the element and tap it, then click; drum
 * while typing; clear the canvas before a screenshot.
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
  private readonly lastPos = new Map<number, SpiderPoint>();
  private readonly lastInject = new Map<number, number>();

  constructor(
    private readonly transport: SpiderTransport = chromeTransport,
    private readonly source: SpiderSettingsSource = spiderSettingsStore,
  ) {}

  /** Agent attached to this tab: show the spider. */
  async activate(tabId: number): Promise<void> {
    await this.load();
    if (!this.settings.enabled) return;
    this.active.add(tabId);
    await this.send(tabId, { op: 'spawn', look: this.look(), at: this.lastPos.get(tabId) }, 400);
  }

  /** Agent detached (task over): the spider climbs away. */
  async deactivate(tabId: number): Promise<void> {
    if (!this.active.delete(tabId)) return;
    await this.send(tabId, { op: 'leave' }, 300);
  }

  /** Tab closed. */
  forget(tabId: number): void {
    this.active.delete(tabId);
    this.lastPos.delete(tabId);
    this.lastInject.delete(tabId);
  }

  isOn(tabId: number): boolean {
    return this.settings.enabled && this.active.has(tabId);
  }

  /** Answer to the content script's hello after a page load in this tab. */
  helloReply(tabId: number | undefined): SpiderHelloReply {
    if (tabId === undefined || !this.isOn(tabId)) return { active: false };
    return { active: true, look: this.look(), at: this.lastPos.get(tabId) };
  }

  /** Walk to `point` and tap it; resolves at the moment of contact or after the cap. */
  async strikeAt(tabId: number, point: SpiderPoint, rect?: SpiderRect): Promise<SpiderAck | null> {
    if (!this.isOn(tabId)) return null;
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
    await this.send(tabId, { op: 'typing', on }, 200);
  }

  scroll(tabId: number, dy: number): void {
    if (!this.isOn(tabId)) return;
    void this.send(tabId, { op: 'scroll', dy }, 200);
  }

  /** Clear the spider off the canvas before a screenshot of the page. */
  async hide(tabId: number): Promise<void> {
    if (!this.isOn(tabId)) return;
    await this.send(tabId, { op: 'hide' }, 300);
  }

  async show(tabId: number): Promise<void> {
    if (!this.isOn(tabId)) return;
    await this.send(tabId, { op: 'show' }, 200);
  }

  async send(tabId: number, cmd: SpiderCommand, capMs: number): Promise<SpiderAck | null> {
    const deadline = Date.now() + capMs;
    try {
      let ack = await this.sendOnce(tabId, cmd, capMs);
      if (ack?.reason === 'not-spawned' && cmd.op !== 'spawn' && cmd.op !== 'leave' && this.active.has(tabId)) {
        // A page that loaded after the hello raced, or a fresh injection.
        await this.sendOnce(tabId, { op: 'spawn', look: this.look(), at: this.lastPos.get(tabId) }, 200);
        ack = await this.sendOnce(tabId, cmd, Math.max(50, deadline - Date.now()));
      }
      if (ack?.pose && ack.visible) this.lastPos.set(tabId, ack.pose.body);
      return ack;
    } catch (error) {
      logger.debug(`spider ${cmd.op} on tab ${tabId} skipped`, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private async sendOnce(tabId: number, cmd: SpiderCommand, capMs: number): Promise<SpiderAck | null> {
    const msg: SpiderMessage = { type: 'browd:spider', cmd };
    try {
      return (await withCap(this.transport.send(tabId, msg), capMs)) ?? null;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!NO_RECEIVER.test(text) || cmd.op === 'leave' || cmd.op === 'show') throw error;
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
    for (const tabId of this.active) {
      if (wasOn && !next.enabled) void this.send(tabId, { op: 'leave' }, 300);
      else if (!wasOn && next.enabled) void this.send(tabId, { op: 'spawn', look: this.look() }, 300);
      else if (next.enabled) void this.send(tabId, { op: 'tune', look: this.look() }, 300);
    }
  }
}

const toRect = (r: SpiderRect): SpiderRect => ({ x: r.x, y: r.y, width: r.width, height: r.height });

export const spiderBridge = new SpiderBridge();
