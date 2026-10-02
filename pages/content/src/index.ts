/**
 * Content script. Hosts the agent spider in the top frame of a tab while
 * the agent works there (see `spider/engine.ts`). It does nothing on a page
 * the agent is not driving: the background answers the hello with
 * `active: false` and no element is ever added.
 */
import type {
  SpiderAck,
  SpiderCommand,
  SpiderHello,
  SpiderHelloReply,
  SpiderMessage,
  SpiderPainted,
  SpiderPoseReport,
} from '@extension/shared';
import { Spider, whenPainted } from './spider/engine';

declare global {
  interface Window {
    __browdSpider?: boolean;
  }
}

// Top frame only (manifest `all_frames: false`); the background may also inject
// this file into a tab that was open before the extension loaded.
if (window.top === window && !window.__browdSpider) {
  window.__browdSpider = true;
  let spider: Spider | null = null;
  const ensure = () => {
    if (!spider) {
      spider = new Spider();
      // The page is unloading: tell the background where the spider was, so
      // it reappears at the same spot on the next page.
      spider.onUnload = place => {
        const report: SpiderPoseReport = { type: 'browd:spider:pose', place };
        chrome.runtime.sendMessage(report).catch(() => {});
      };
    }
    return spider;
  };

  const run = async (cmd: SpiderCommand): Promise<SpiderAck> => {
    switch (cmd.op) {
      case 'spawn': {
        const sp = ensure();
        if (cmd.focus) sp.focus(cmd.focus);
        if (cmd.mood) sp.mood(cmd.mood);
        return sp.spawn(cmd.look, cmd.at, cmd.arrive);
      }
      case 'tune':
        return ensure().tune(cmd.look);
      case 'approach':
        return ensure().approach(cmd.point, cmd.rect, cmd.capMs);
      case 'strike':
        return ensure().strike(cmd.point, cmd.rect);
      case 'typing':
        return ensure().typing(cmd.on);
      case 'scroll':
        return ensure().scroll();
      case 'depart':
        return ensure().depart();
      case 'handoff':
        return ensure().handoff();
      case 'exit':
        return ensure().exit(cmd.side);
      case 'hide':
        return ensure().hide();
      case 'show':
        return ensure().show();
      case 'leave':
        return ensure().leave();
      case 'mood':
        return ensure().mood(cmd.mood);
      case 'scan':
        return ensure().scan(cmd.on);
      case 'focus':
        return ensure().focus(cmd.words);
      case 'state':
        return ensure().state();
    }
  };

  chrome.runtime.onMessage.addListener((msg: SpiderMessage, sender, sendResponse) => {
    if (msg?.type !== 'browd:spider' || sender.id !== chrome.runtime.id) return false;
    run(msg.cmd).then(sendResponse, () => sendResponse({ ok: false, visible: false } satisfies SpiderAck));
    return true;
  });

  const hello: SpiderHello = { type: 'browd:spider:hello' };
  chrome.runtime
    .sendMessage(hello)
    .then((reply: SpiderHelloReply | undefined) => {
      if (reply?.parked) {
        // The spider waits in the chat: it may move there once this page has replaced the old one on screen.
        const painted: SpiderPainted = { type: 'browd:spider:painted' };
        void whenPainted(1500).then(() => chrome.runtime.sendMessage(painted).catch(() => {}));
        return;
      }
      if (!reply?.active || !reply.look) return;
      const sp = ensure();
      if (reply.focus) sp.focus(reply.focus);
      if (reply.mood) sp.mood(reply.mood);
      sp.spawn(reply.look, reply.at, reply.arrive);
    })
    .catch(() => {
      // No background listener (extension reloading) — stay silent.
    });
}
