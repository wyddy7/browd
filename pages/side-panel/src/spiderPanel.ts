/**
 * The agent spider's seat in the chat panel. During a burst of navigations the
 * background "parks" the spider here instead of on pages that keep being
 * replaced. Same engine as on pages (`pages/content/src/spider`), on the
 * panel's own document: it leaps in from the left edge (the page sits to the
 * left of the panel), reads the chat while it waits, and leaps back out to the
 * left when the agent acts on the page again. No words are torn out here.
 */
import type { SpiderAck, SpiderPanelMessage } from '@extension/shared';
import { Spider } from '@spider/engine';

let spider: Spider | null = null;
let safety = 0;
const none: SpiderAck = { ok: true, visible: false };

/**
 * The task ended (as the panel sees it). The background normally sends `leave`
 * itself; if the spider is still sitting here a moment later — the background
 * lost track of it — it leaves anyway, so a stray one never stays next to a
 * spider on the page.
 */
export function panelSpiderTaskEnded(): void {
  window.clearTimeout(safety);
  safety = window.setTimeout(() => {
    if (spider?.spawned) spider.leave();
  }, 3000);
}

export function startPanelSpider(): () => void {
  const handle = async (msg: SpiderPanelMessage): Promise<SpiderAck> => {
    switch (msg.op) {
      case 'park': {
        if (!msg.look) return { ok: false, visible: false };
        window.clearTimeout(safety);
        spider ??= new Spider();
        if (msg.mood) spider.mood(msg.mood);
        const at = { x: 96, y: Math.round(innerHeight * 0.62), heading: 0 };
        return spider.spawn({ ...msg.look, tear: false }, at, 'edge');
      }
      case 'unpark':
        return spider ? spider.exit('left') : none;
      case 'mood':
        return spider && msg.mood ? spider.mood(msg.mood) : none;
      case 'leave':
        if (!spider) return none;
        if (msg.mood) spider.mood(msg.mood);
        return spider.leave();
      case 'state':
        return spider ? spider.state() : none;
      case 'metrics': {
        spider ??= new Spider();
        const ack = spider.metrics();
        let side: 'left' | 'right' = 'right';
        try {
          // chrome.sidePanel.getLayout: Chrome 140+, newer than the bundled typings.
          const api = chrome.sidePanel as unknown as { getLayout?: () => Promise<{ side?: string }> };
          side = (await api.getLayout?.())?.side === 'left' ? 'left' : 'right';
        } catch {
          // Older browsers: the panel is on the right.
        }
        return ack.metrics ? { ...ack, metrics: { ...ack.metrics, side } } : ack;
      }
      case 'crossOut':
        return spider && msg.to && msg.T ? spider.crossOut(msg.to, msg.T, msg.bow ?? 0) : { ok: false, visible: false };
      case 'crossIn':
        if (!msg.plan || !msg.look) return { ok: false, visible: false };
        window.clearTimeout(safety);
        spider ??= new Spider();
        if (msg.mood) spider.mood(msg.mood);
        return spider.crossIn(msg.plan, { ...msg.look, tear: false });
    }
  };

  const listener = (msg: SpiderPanelMessage, sender: chrome.runtime.MessageSender, reply: (a: SpiderAck) => void) => {
    if (msg?.type !== 'browd:spider:panel' || sender.id !== chrome.runtime.id) return false;
    handle(msg).then(reply, () => reply({ ok: false, visible: false }));
    return true;
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
