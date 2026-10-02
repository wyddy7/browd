/**
 * SpiderBridge — the background "handles" of the agent spider. The spider
 * is decoration, so the contract under test is mostly about what must
 * never happen: a failing or missing content script must not throw into
 * an agent action or hold it past the caps, and a disabled spider must
 * not send anything at all.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SpiderAck, SpiderMessage } from '@extension/shared';
import type { SpiderSettings } from '@extension/storage';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@extension/storage', () => ({
  DEFAULT_SPIDER_SETTINGS: { enabled: true, size: 1, pace: 'normal', marks: 'target' },
  normalizeSpiderSettings: (s: SpiderSettings) => s,
  spiderSettingsStore: { getSettings: vi.fn(), subscribe: vi.fn() },
}));

import { SpiderBridge, type SpiderTransport, type SpiderSettingsSource } from '../spider';

const ON: SpiderSettings = { enabled: true, size: 1, pace: 'normal', marks: 'target' };
const ack = (extra: Partial<SpiderAck> = {}): SpiderAck => ({
  ok: true,
  visible: true,
  pose: {
    body: { x: 10, y: 20 },
    heading: 0,
    hands: [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ],
    feet: [],
    speed: 0,
  },
  ...extra,
});

function setup(settings: SpiderSettings = ON, send?: SpiderTransport['send']) {
  const sent: SpiderMessage[] = [];
  let listener: (() => void) | null = null;
  let current = settings;
  const transport: SpiderTransport = {
    send: vi.fn(async (_tabId, msg) => {
      sent.push(msg);
      return send ? send(_tabId, msg) : ack();
    }),
    inject: vi.fn(async () => {}),
  };
  const source: SpiderSettingsSource = {
    getSettings: async () => current,
    subscribe: l => {
      listener = l;
      return () => {};
    },
  };
  const bridge = new SpiderBridge(transport, source);
  const change = async (next: SpiderSettings) => {
    current = next;
    listener?.();
    await new Promise(r => setTimeout(r, 0));
  };
  return { bridge, transport, sent, ops: () => sent.map(m => m.cmd.op), change };
}

describe('SpiderBridge', () => {
  it('spawns on activate, walks and strikes on strikeAt, leaves on deactivate', async () => {
    const { bridge, ops } = setup();
    await bridge.activate(7);
    await bridge.strikeAt(7, { x: 100, y: 50 }, { x: 90, y: 40, width: 20, height: 20 });
    await bridge.deactivate(7);
    expect(ops()).toEqual(['spawn', 'approach', 'strike', 'leave']);
    expect(bridge.isOn(7)).toBe(false);
  });

  it('sends nothing when disabled', async () => {
    const { bridge, transport } = setup({ ...ON, enabled: false });
    await bridge.activate(7);
    await bridge.strikeAt(7, { x: 1, y: 1 });
    await bridge.hide(7);
    bridge.scroll(7, 100);
    await bridge.deactivate(7);
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('ignores tabs the agent never attached', async () => {
    const { bridge, transport } = setup();
    await bridge.strikeAt(3, { x: 1, y: 1 });
    await bridge.typing(3, true);
    expect(transport.send).not.toHaveBeenCalled();
    expect(bridge.helloReply(3)).toEqual({ active: false });
  });

  it('answers the hello of an active tab with the look and the last position', async () => {
    const { bridge } = setup();
    await bridge.activate(7);
    expect(bridge.helloReply(7)).toEqual({
      active: true,
      look: { size: 1, pace: 'normal', marks: 'target' },
      at: { x: 10, y: 20 },
    });
    expect(bridge.helloReply(undefined)).toEqual({ active: false });
  });

  it('never throws when the content script errors', async () => {
    const { bridge } = setup(ON, async () => {
      throw new Error('The tab was closed.');
    });
    await expect(bridge.activate(7)).resolves.toBeUndefined();
    await expect(bridge.strikeAt(7, { x: 1, y: 1 })).resolves.toBeNull();
    await expect(bridge.hide(7)).resolves.toBeUndefined();
  });

  it('gives up at the cap when the content script never answers', async () => {
    const { bridge } = setup(ON, () => new Promise(() => {}));
    await bridge.activate(7); // spawn cap 400 ms
    const t0 = Date.now();
    await bridge.hide(7); // cap 300 ms
    expect(Date.now() - t0).toBeLessThan(450);
  });

  it('injects the content script once into a tab opened before the extension loaded', async () => {
    let injected = false;
    const { bridge, transport } = setup(ON, async () => {
      if (!injected) throw new Error('Could not establish connection. Receiving end does not exist.');
      return ack();
    });
    vi.mocked(transport.inject).mockImplementation(async () => {
      injected = true;
    });
    await bridge.activate(7);
    expect(transport.inject).toHaveBeenCalledTimes(1);
    expect(bridge.isOn(7)).toBe(true);
  });

  it('respawns and retries once when the page has no spider yet (hello raced)', async () => {
    let spawned = false;
    const { bridge, ops } = setup(ON, async (_t, msg) => {
      if (msg.cmd.op === 'spawn') {
        spawned = true;
        return ack();
      }
      return spawned ? ack({ arrived: true }) : ack({ ok: false, reason: 'not-spawned', visible: false });
    });
    await bridge.activate(7);
    spawned = false; // the page navigated
    await bridge.strikeAt(7, { x: 1, y: 1 });
    expect(ops()).toEqual(['spawn', 'approach', 'spawn', 'approach', 'strike']);
  });

  it('forwards live settings changes to the spider on screen', async () => {
    const { bridge, ops, change } = setup();
    await bridge.activate(7);
    await change({ ...ON, size: 1.35 });
    await change({ ...ON, size: 1.35, enabled: false });
    expect(ops()).toEqual(['spawn', 'tune', 'leave']);
    expect(bridge.isOn(7)).toBe(false);
  });

  it('scales the approach cap with the pace', async () => {
    const { bridge, sent } = setup({ ...ON, pace: 'calm' });
    await bridge.activate(7);
    await bridge.strikeAt(7, { x: 1, y: 1 });
    const approach = sent.find(m => m.cmd.op === 'approach')!.cmd as { capMs: number };
    expect(approach.capMs).toBe(1215);
  });
});
