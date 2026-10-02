/**
 * Content script. Hosts the agent spider in the top frame of a tab while
 * the agent works there (see `spider/engine.ts`). It does nothing on a page
 * the agent is not driving: the background answers the hello with
 * `active: false` and no element is ever added.
 */
import type { SpiderAck, SpiderCommand, SpiderHello, SpiderHelloReply, SpiderMessage } from '@extension/shared';
import { Spider } from './spider/engine';

declare global {
  interface Window {
    __browdSpider?: boolean;
  }
}

// The manifest injects into every frame; the background may also inject
// this file into a tab that was open before the extension loaded.
if (window.top === window && !window.__browdSpider) {
  window.__browdSpider = true;
  let spider: Spider | null = null;
  const ensure = () => (spider ??= new Spider());

  const run = async (cmd: SpiderCommand): Promise<SpiderAck> => {
    switch (cmd.op) {
      case 'spawn':
        return ensure().spawn(cmd.look, cmd.at);
      case 'tune':
        return ensure().tune(cmd.look);
      case 'approach':
        return ensure().approach(cmd.point, cmd.rect, cmd.capMs);
      case 'strike':
        return ensure().strike(cmd.point, cmd.rect);
      case 'typing':
        return ensure().typing(cmd.on);
      case 'scroll':
        return ensure().scroll(cmd.dy);
      case 'hide':
        return ensure().hide();
      case 'show':
        return ensure().show();
      case 'leave':
        return ensure().leave();
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
      if (reply?.active && reply.look) ensure().spawn(reply.look, reply.at);
    })
    .catch(() => {
      // No background listener (extension reloading) — stay silent.
    });
}
