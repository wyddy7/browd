/**
 * SpiderBridge — the background "handles" of the agent spider. The spider
 * is decoration, so most of the contract is about what must never happen:
 * a failing or missing content script must not throw into an agent action
 * or hold it past the caps, a disabled spider sends nothing, and there is
 * only ever one spider — in the current tab — that teleports when the agent
 * moves to another tab or page.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SpiderAck, SpiderCommand, SpiderMessage } from '@extension/shared';
import type { SpiderSettings } from '@extension/storage';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@extension/storage', () => ({
  DEFAULT_SPIDER_SETTINGS: { enabled: true, size: 1, pace: 'normal', marks: 'target', color: 'violet', tear: true },
  normalizeSpiderSettings: (s: SpiderSettings) => s,
  spiderSettingsStore: { getSettings: vi.fn(), subscribe: vi.fn() },
}));

import { SpiderBridge, type SpiderTransport, type SpiderSettingsSource } from '../spider';

const ON: SpiderSettings = { enabled: true, size: 1, pace: 'normal', marks: 'target', color: 'violet', tear: true };
const ack = (extra: Partial<SpiderAck> = {}): SpiderAck => ({
  ok: true,
  visible: true,
  pose: {
    body: { x: 10, y: 20 },
    heading: 1.5,
    mode: 'idle:pause',
    scale: 1,
    abdomenLag: 0,
    hands: [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ],
    feet: [],
    hips: [],
    knees: [],
    maxStretch: 0.8,
    speed: 0,
  },
  ...extra,
});

function setup(settings: SpiderSettings = ON, send?: SpiderTransport['send']) {
  const sent: Array<{ tabId: number; cmd: SpiderCommand }> = [];
  let listener: (() => void) | null = null;
  let current = settings;
  const transport: SpiderTransport = {
    send: vi.fn(async (tabId: number, msg: SpiderMessage) => {
      sent.push({ tabId, cmd: msg.cmd });
      return send ? send(tabId, msg) : ack();
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
  const ops = () => sent.map(({ tabId, cmd }) => `${tabId}:${cmd.op}${cmd.op === 'spawn' ? `/${cmd.arrive}` : ''}`);
  return { bridge, transport, sent, ops, change };
}

describe('SpiderBridge', () => {
  it('descends on the first attach, walks and strikes, climbs away at the end', async () => {
    const { bridge, ops } = setup();
    await bridge.activate(7);
    await bridge.strikeAt(7, { x: 100, y: 50 }, { x: 90, y: 40, width: 20, height: 20 });
    await bridge.deactivate(7);
    expect(ops()).toEqual(['7:spawn/descend', '7:approach', '7:strike', '7:leave']);
    expect(bridge.isOn(7)).toBe(false);
  });

  it('moves the one spider to another tab: depart there, teleport here, at the last place', async () => {
    const { bridge, ops, sent } = setup();
    await bridge.activate(7);
    await bridge.activate(8);
    expect(ops()).toEqual(['7:spawn/descend', '7:depart', '8:spawn/teleport']);
    const spawn = sent.at(-1)!.cmd as Extract<SpiderCommand, { op: 'spawn' }>;
    expect(spawn.at).toEqual({ x: 10, y: 20, heading: 1.5 });
    // Acting in the first tab again brings it back there.
    await bridge.strikeAt(7, { x: 1, y: 1 });
    expect(ops().slice(3)).toEqual(['8:depart', '7:spawn/teleport', '7:approach', '7:strike']);
  });

  it('answers a hello only from the current tab, and as a teleport after the first entrance', async () => {
    const { bridge } = setup();
    await bridge.activate(7);
    await bridge.activate(8);
    expect(bridge.helloReply(7)).toEqual({ active: false });
    bridge.reportPlace(8, { x: 300, y: 200, heading: 0.4 });
    expect(bridge.helloReply(8)).toEqual({
      active: true,
      look: { size: 1, pace: 'normal', marks: 'target', color: 'violet', tear: true },
      at: { x: 300, y: 200, heading: 0.4 },
      arrive: 'teleport',
      focus: [],
    });
    expect(bridge.helloReply(undefined)).toEqual({ active: false });
  });

  it('ignores place reports from other tabs and malformed ones', async () => {
    const { bridge } = setup();
    await bridge.activate(7);
    bridge.reportPlace(9, { x: 1, y: 1, heading: 0 });
    bridge.reportPlace(7, { x: Number.NaN, y: 1, heading: 0 });
    expect(bridge.helloReply(7).at).toEqual({ x: 10, y: 20, heading: 1.5 });
  });

  it('forgets the place when the task ends, so the next task descends again', async () => {
    const { bridge, ops } = setup();
    await bridge.activate(7);
    await bridge.deactivate(7);
    await bridge.activate(7);
    expect(ops()).toEqual(['7:spawn/descend', '7:leave', '7:spawn/descend']);
  });

  it('departs before a navigation of the current tab only', async () => {
    const { bridge, ops } = setup();
    await bridge.activate(7);
    await bridge.depart(7);
    await bridge.depart(9);
    expect(ops()).toEqual(['7:spawn/descend', '7:depart']);
  });

  it('sends nothing when disabled', async () => {
    const { bridge, transport } = setup({ ...ON, enabled: false });
    await bridge.activate(7);
    await bridge.strikeAt(7, { x: 1, y: 1 });
    await bridge.beforeCapture(7);
    bridge.scrolled(7, 100);
    await bridge.depart(7);
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

  it('never throws when the content script errors', async () => {
    const { bridge } = setup(ON, async () => {
      throw new Error('The tab was closed.');
    });
    await expect(bridge.activate(7)).resolves.toBeUndefined();
    await expect(bridge.strikeAt(7, { x: 1, y: 1 })).resolves.toBeNull();
    await expect(bridge.beforeCapture(7)).resolves.toBeUndefined();
    await expect(bridge.depart(7)).resolves.toBeUndefined();
  });

  it('gives up at the cap when the content script never answers', async () => {
    const { bridge } = setup(ON, () => new Promise(() => {}));
    await bridge.activate(7); // spawn cap 400 ms
    const t0 = Date.now();
    await bridge.beforeCapture(7); // cap 300 ms
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

  it('respawns as a teleport and retries once when the page has no spider yet (hello raced)', async () => {
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
    expect(ops()).toEqual(['7:spawn/descend', '7:approach', '7:spawn/teleport', '7:approach', '7:strike']);
  });

  it('forwards live settings changes to the spider on screen', async () => {
    const { bridge, ops, change } = setup();
    await bridge.activate(7);
    await change({ ...ON, size: 1.35 });
    await change({ ...ON, size: 1.35, enabled: false });
    expect(ops()).toEqual(['7:spawn/descend', '7:tune', '7:leave']);
    expect(bridge.isOn(7)).toBe(false);
  });

  it('turned on mid-task, comes to the tab the agent is already in', async () => {
    const { bridge, ops, change } = setup({ ...ON, enabled: false });
    await bridge.activate(7);
    expect(ops()).toEqual([]);
    await change(ON);
    expect(ops()).toEqual(['7:spawn/descend']);
  });

  it('follows the agent: focus words from the task, moods sent once per change, ending mood before the climb', async () => {
    const { bridge, sent } = setup();
    bridge.setTask('go to news.ycombinator.com, find the post about AI agents with the most comments today');
    await bridge.activate(7);
    const spawn = sent[0].cmd as Extract<SpiderCommand, { op: 'spawn' }>;
    expect(spawn.focus).toEqual(['AI'.toLowerCase(), 'agent', 'comment']);
    const live = (d: object) => ({ state: 'task.live', data: { details: JSON.stringify(d) } });
    await bridge.onAgentEvent(live({ kind: 'llm_streaming', tokensSoFar: 20 }));
    await bridge.onAgentEvent(live({ kind: 'llm_streaming', tokensSoFar: 40 }));
    await bridge.onAgentEvent(live({ kind: 'tool_start', name: 'go_to_url' }));
    await bridge.onAgentEvent(live({ kind: 'tool_start', name: 'click_element' }));
    await bridge.onAgentEvent({ state: 'task.hitl.ask', data: { details: '' } });
    await bridge.onAgentEvent({ state: 'task.ok', data: { details: 'done' } });
    await bridge.deactivate(7);
    const moods = sent.filter(m => m.cmd.op === 'mood').map(m => (m.cmd as { mood: string }).mood);
    expect(moods).toEqual(['thinking', 'waiting', 'acting', 'asking', 'done']);
    expect(sent.at(-1)!.cmd.op).toBe('leave');
  });

  it('switches the focus to the active subgoal when the plan changes', async () => {
    const { bridge, sent } = setup();
    bridge.setTask('summarize the top thread');
    await bridge.activate(7);
    const plan = {
      type: 'plan',
      items: [
        { text: 'Open Hacker News', done: true },
        { text: 'Compare comment counts of OpenShell posts', done: false, inProgress: true },
      ],
    };
    await bridge.onAgentEvent({ state: 'step.ok', data: { details: JSON.stringify(plan) } });
    const focus = sent.filter(m => m.cmd.op === 'focus').at(-1)!.cmd as { words: string[] };
    expect(focus.words).toEqual(['comment', 'count', 'openshell']);
  });

  it('carries a place only from a spider standing on the page, not from one on its thread', async () => {
    const descending = ack();
    descending.pose!.mode = 'descend';
    descending.pose!.body = { x: 600, y: -80 };
    const { bridge, sent } = setup(ON, async () => descending);
    await bridge.activate(7);
    await bridge.activate(8);
    const spawn = sent.at(-1)!.cmd as Extract<SpiderCommand, { op: 'spawn' }>;
    expect(spawn.at).toBeUndefined();
  });

  it('scales the approach cap with the pace', async () => {
    const { bridge, sent } = setup({ ...ON, pace: 'calm' });
    await bridge.activate(7);
    await bridge.strikeAt(7, { x: 1, y: 1 });
    const approach = sent.find(m => m.cmd.op === 'approach')!.cmd as { capMs: number };
    expect(approach.capMs).toBe(1215);
  });
});
