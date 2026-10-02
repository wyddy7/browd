/**
 * SpiderBridge — the background "handles" of the agent spider. The spider
 * is decoration, so most of the contract is about what must never happen:
 * a failing or missing content script must not throw into an agent action
 * or hold it past the caps, a disabled spider sends nothing, and there is
 * only ever one spider — in the current tab — that teleports when the agent
 * moves to another tab or page.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SpiderAck, SpiderCommand, SpiderMessage, SpiderPanelMessage } from '@extension/shared';
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

function setup(
  settings: SpiderSettings = ON,
  send?: SpiderTransport['send'],
  panel?: (msg: SpiderPanelMessage) => Promise<SpiderAck | undefined>,
) {
  const sent: Array<{ tabId: number; cmd: SpiderCommand }> = [];
  const panelOps: string[] = [];
  /** Page and panel messages in the order they were sent: the one-spider rule is about order. */
  const timeline: string[] = [];
  let listener: (() => void) | null = null;
  let current = settings;
  const transport: SpiderTransport = {
    send: vi.fn(async (tabId: number, msg: SpiderMessage) => {
      sent.push({ tabId, cmd: msg.cmd });
      timeline.push(`${tabId}:${msg.cmd.op}${msg.cmd.op === 'spawn' ? `/${msg.cmd.arrive}` : ''}`);
      return send ? send(tabId, msg) : ack();
    }),
    inject: vi.fn(async () => {}),
    ...(panel
      ? {
          panel: async (msg: SpiderPanelMessage) => {
            panelOps.push(msg.op);
            timeline.push(`panel:${msg.op}`);
            return panel(msg);
          },
        }
      : {}),
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
  return { bridge, transport, sent, ops, change, panelOps, timeline };
}

/** A controllable clock for the burst window. */
function clock(start = 1_000_000) {
  let now = start;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return { advance: (ms: number) => (now += ms) };
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

  it('answers a hello only from the current tab; the next page of that tab is a handoff at the place it unloaded', async () => {
    const { bridge } = setup();
    await bridge.activate(7);
    await bridge.activate(8);
    expect(bridge.helloReply(7)).toEqual({ active: false });
    bridge.reportPlace(8, { x: 300, y: 200, heading: 0.4 });
    expect(bridge.helloReply(8)).toEqual({
      active: true,
      look: { size: 1, pace: 'normal', marks: 'target', color: 'violet', tear: true },
      at: { x: 300, y: 200, heading: 0.4 },
      arrive: 'handoff',
      focus: [],
    });
    expect(bridge.helloReply(undefined)).toEqual({ active: false });
  });

  it('hands off before a navigation: no collapse, the full place (legs too) goes to the next page', async () => {
    const feet = Array.from({ length: 8 }, (_, i) => ({ x: i, y: -i }));
    const { bridge, ops } = setup(ON, async (_tab, msg) =>
      msg.cmd.op === 'handoff'
        ? ack({ place: { x: 120, y: 340, heading: 0.25, feet, abdomen: { x: -13, y: 0 } } })
        : ack(),
    );
    await bridge.activate(7);
    await bridge.beforeNavigate(7);
    expect(ops()).toEqual(['7:spawn/descend', '7:handoff']);
    const reply = bridge.helloReply(7);
    expect(reply.arrive).toBe('handoff');
    expect(reply.at).toEqual({ x: 120, y: 340, heading: 0.25, feet, abdomen: { x: -13, y: 0 } });
    expect(reply.mood).toBe('waiting');
  });

  it('still teleports between tabs (another tab is another place, not the next page)', async () => {
    const { bridge, ops } = setup();
    await bridge.activate(7);
    await bridge.beforeNavigate(7);
    await bridge.activate(8);
    expect(ops()).toEqual(['7:spawn/descend', '7:handoff', '7:depart', '8:spawn/teleport']);
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

  it('tells the spider to hold still while the agent reads the DOM, current tab only', async () => {
    const { bridge, ops } = setup();
    await bridge.activate(7);
    await bridge.scanning(7, true);
    await bridge.scanning(7, false);
    await bridge.scanning(9, true);
    expect(ops()).toEqual(['7:spawn/descend', '7:scan', '7:scan']);
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
    await bridge.onAgentEvent({ state: 'act.start', data: { details: 'Click the Join button' } });
    await bridge.onAgentEvent({ state: 'act.ok', data: { details: 'Clicked' } });
    await bridge.onAgentEvent({ state: 'task.hitl.ask', data: { details: '' } });
    await bridge.onAgentEvent({ state: 'task.ok', data: { details: 'done' } });
    await bridge.deactivate(7);
    const moods = sent.filter(m => m.cmd.op === 'mood').map(m => (m.cmd as { mood: string }).mood);
    expect(moods).toEqual(['thinking', 'waiting', 'acting', 'thinking', 'asking', 'done']);
    expect(sent.at(-1)!.cmd.op).toBe('leave');
  });

  it('takes focus words from a Russian task without its verbs and fillers', async () => {
    const { bridge, sent } = setup();
    bridge.setTask('найди на хабре самую обсуждаемую статью про агентов и открой её');
    await bridge.activate(7);
    const spawn = sent[0].cmd as Extract<SpiderCommand, { op: 'spawn' }>;
    expect(spawn.focus).toEqual(['хабре', 'обсуждаемую', 'статью', 'агентов']);
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

  describe('the chat panel during a long burst of navigations (never two spiders)', () => {
    const openPanel = async () => ({ ok: true, visible: true });
    const parkable = (panel: (msg: SpiderPanelMessage) => Promise<SpiderAck | undefined> = openPanel) => {
      const env = setup(ON, undefined, panel);
      env.bridge.setPanelOpen(true);
      return env;
    };

    it('one or two quick hops stay on the pages; the third goes to the chat — out of the page first, then into the panel', async () => {
      const t = clock();
      const { bridge, timeline } = parkable();
      await bridge.activate(7);
      await bridge.beforeNavigate(7);
      t.advance(2500);
      await bridge.beforeNavigate(7);
      expect(timeline).toEqual(['7:spawn/descend', '7:handoff', '7:handoff']);
      t.advance(2500);
      await bridge.beforeNavigate(7);
      expect(timeline.slice(3)).toEqual(['7:exit', 'panel:park']);
      // In the chat: new pages stay empty, page commands are not sent.
      expect(bridge.helloReply(7)).toEqual({ active: false, parked: true });
      await bridge.beforeCapture(7);
      expect(timeline).toHaveLength(5);
      // Back on the next click: out of the panel first, then into the page from the right edge.
      await bridge.strikeAt(7, { x: 100, y: 50 });
      expect(timeline.slice(5)).toEqual(['panel:unpark', '7:spawn/edge', '7:approach', '7:strike']);
      vi.restoreAllMocks();
    });

    it('a plan naming three sites goes to the chat from the first navigation', async () => {
      clock();
      const { bridge, timeline } = parkable();
      bridge.setTask('compare prices on amazon.com, ebay.com and walmart.com');
      await bridge.activate(7);
      await bridge.beforeNavigate(7);
      expect(timeline).toEqual(['7:spawn/descend', '7:exit', 'panel:park']);
      vi.restoreAllMocks();
    });

    it('after a link click the panel waits for the next page to paint over the old one', async () => {
      const t = clock();
      const { bridge, timeline } = parkable();
      await bridge.activate(7);
      await bridge.beforeNavigate(7);
      t.advance(2500);
      await bridge.beforeNavigate(7);
      t.advance(2500);
      bridge.reportPlace(7, { x: 1, y: 2, heading: 0 }); // third navigation: a link click unloads the page
      await new Promise(r => setTimeout(r, 0));
      expect(timeline.slice(3)).toEqual(['7:exit']);
      expect(bridge.helloReply(7)).toEqual({ active: false, parked: true });
      bridge.pagePainted(7);
      await new Promise(r => setTimeout(r, 0));
      expect(timeline.slice(4)).toEqual(['panel:park']);
      vi.restoreAllMocks();
    });

    it('stays on the pages when no chat panel is open', async () => {
      const t = clock();
      const { bridge, ops } = setup(ON, undefined, openPanel);
      await bridge.activate(7);
      for (let i = 0; i < 3; i++) {
        await bridge.beforeNavigate(7);
        t.advance(2500);
      }
      expect(ops()).toEqual(['7:spawn/descend', '7:handoff', '7:handoff', '7:handoff']);
      expect(bridge.helloReply(7).active).toBe(true);
      vi.restoreAllMocks();
    });

    it('counts a navigation once (the hook before it and the page unload after it)', async () => {
      const t = clock();
      const { bridge, panelOps } = parkable();
      await bridge.activate(7);
      await bridge.beforeNavigate(7);
      t.advance(400);
      bridge.reportPlace(7, { x: 1, y: 2, heading: 0 });
      t.advance(2500);
      await bridge.beforeNavigate(7);
      t.advance(400);
      bridge.reportPlace(7, { x: 1, y: 2, heading: 0 });
      await new Promise(r => setTimeout(r, 0));
      expect(panelOps).toEqual([]);
      vi.restoreAllMocks();
    });

    it('back to the page after 8 s without a navigation; goodbye from the chat when the task ends there', async () => {
      const t = clock();
      const { bridge, timeline } = parkable();
      bridge.setTask('a.com b.com c.com');
      await bridge.activate(7);
      await bridge.beforeNavigate(7);
      t.advance(9000);
      await bridge.onAgentEvent({ actor: 'navigator', state: 'step.start', data: { details: '' } } as never);
      expect(timeline.slice(-2)).toEqual(['panel:unpark', '7:spawn/edge']);
      // The plan's prediction was used once; now it takes three quick hops again.
      t.advance(1000);
      await bridge.beforeNavigate(7);
      expect(timeline.at(-1)).toBe('7:handoff');
      t.advance(2500);
      await bridge.beforeNavigate(7);
      t.advance(2500);
      await bridge.beforeNavigate(7);
      await bridge.deactivate(7);
      expect(timeline.slice(-3)).toEqual(['7:exit', 'panel:park', 'panel:leave']);
      expect(timeline).not.toContain('7:leave');
      vi.restoreAllMocks();
    });

    it('crosses the seam when both sides can be measured: one plan, the panel draws it in its own coordinates', async () => {
      clock();
      const pagePlan = {
        t0: 1000,
        T: 650,
        from: { x: 900, y: 500 },
        v0: { x: 100, y: 0 },
        to: { x: 1300, y: 600 },
        bow: 0.04,
        heading: 0,
        size: 1,
      };
      const panelPlan = { ...pagePlan, from: { x: 50, y: 470 }, to: { x: -200, y: 400 }, v0: { x: -300, y: 0 } };
      const panelMsgs: SpiderPanelMessage[] = [];
      const pageCmds: SpiderCommand[] = [];
      const env = setup(
        ON,
        async (_tab, msg) => {
          pageCmds.push(msg.cmd);
          if (msg.cmd.op === 'metrics') return ack({ metrics: { width: 1000, height: 800, dpr: 2, outerWidth: 1404 } });
          if (msg.cmd.op === 'crossOut') return ack({ cross: { plan: { ...pagePlan, to: msg.cmd.to }, clearAt: 0 } });
          return ack();
        },
        async msg => {
          panelMsgs.push(msg);
          if (msg.op === 'metrics')
            return {
              ok: true,
              visible: true,
              metrics: { width: 400, height: 760, dpr: 2, outerWidth: 1404, side: 'right' },
            };
          if (msg.op === 'crossOut' && msg.to)
            return { ok: true, visible: true, cross: { plan: { ...panelPlan, to: msg.to }, clearAt: 0 } };
          return { ok: true, visible: true };
        },
      );
      env.transport.zoom = async () => 1;
      env.bridge.setPanelOpen(true);
      env.bridge.setTask('a.com b.com c.com');
      await env.bridge.activate(7);
      await env.bridge.beforeNavigate(7);
      expect(env.timeline).toEqual(['7:spawn/descend', '7:metrics', 'panel:metrics', '7:crossOut', 'panel:crossIn']);
      // Page 1000 px wide, 4 px spare = a 2 px panel margin: page x 900 is 102 px left of the panel,
      // and the panel's bottom is 2 px above the page's.
      const crossIn = panelMsgs.find(m => m.op === 'crossIn');
      expect(crossIn?.plan?.from).toEqual({ x: -102, y: 462 });
      expect(crossIn?.plan?.to.x).toBeCloseTo(96, 6);
      expect(crossIn?.plan?.to.y).toBeCloseTo(471, 6);
      expect(crossIn?.plan?.t0).toBe(1000);
      expect(env.bridge.helloReply(7)).toEqual({ active: false, parked: true });
      // Back: the panel leaves across the seam, the page joins the same flight, then walks on to the click.
      await env.bridge.strikeAt(7, { x: 300, y: 300 });
      expect(env.timeline.slice(5)).toEqual([
        '7:metrics',
        'panel:metrics',
        'panel:crossOut',
        '7:crossIn',
        '7:approach',
        '7:strike',
      ]);
      // The panel's x 50 is 52 px right of the page's edge (1000 + the 2 px margin); landing 120 px inside the page.
      const pageIn = pageCmds.find(c => c.op === 'crossIn');
      expect(pageIn?.op === 'crossIn' && pageIn.plan.from).toEqual({ x: 1052, y: 508 });
      expect(pageIn?.op === 'crossIn' && pageIn.plan.to.x).toBeCloseTo(880, 6);
      vi.restoreAllMocks();
    });

    it('a panel that refuses the spider sends it back onto the page', async () => {
      clock();
      const { bridge, timeline } = parkable(async () => undefined);
      bridge.setTask('a.com b.com c.com');
      await bridge.activate(7);
      await bridge.beforeNavigate(7);
      expect(timeline).toEqual(['7:spawn/descend', '7:exit', 'panel:park', '7:spawn/edge']);
      expect(bridge.helloReply(7).active).toBe(true);
      vi.restoreAllMocks();
    });
  });
});
