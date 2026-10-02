/**
 * Reads the agent's execution events into what the spider shows: a mood and
 * the words it is looking for. Pure functions — no Chrome, no state — so the
 * mapping is unit-tested on its own.
 */
import type { SpiderMood } from '@extension/shared';

export interface AgentEventLike {
  state: string;
  data?: { details?: string } | null;
}

/** Tools that load a page: the spider waits. */
const LOADING_TOOLS = new Set([
  'go_to_url',
  'go_back',
  'open_tab',
  'switch_tab',
  'search_google',
  'take_over_user_tab',
]);
/** Tools that touch the page: the spider is alert, an approach follows. */
const ACTING_TOOLS = new Set([
  'click_element',
  'input_text',
  'fill_field_by_label',
  'click_at',
  'type_at',
  'drag_at',
  'scroll_at',
  'send_keys',
  'select_dropdown_option',
  'hitl_click_at',
]);

/**
 * The mood an event implies, or null when it says nothing new (most events).
 * `details` of `task.live` is JSON: `{kind: 'llm_streaming' | 'tool_start' | 'node' | …}`.
 */
export function moodOf(event: AgentEventLike): SpiderMood | null {
  switch (event.state) {
    case 'task.start':
    case 'task.resume':
    case 'step.start':
      return 'thinking';
    // Every action reports start and end through these; the tool events of
    // a subgoal's inner agent do not always reach the outer stream.
    case 'act.start':
      return 'acting';
    case 'act.ok':
    case 'act.fail':
      return 'thinking';
    case 'task.hitl.approve':
    case 'task.hitl.ask':
      return 'asking';
    case 'task.ok':
      return 'done';
    case 'task.fail':
    case 'task.cancel':
      return 'failed';
    case 'task.live': {
      const live = parse(event.data?.details);
      if (!live) return null;
      if (live.kind === 'llm_streaming') return 'thinking';
      if (live.kind === 'node' && live.state === 'start') return 'thinking';
      if (live.kind === 'tool_start' && typeof live.name === 'string') {
        if (LOADING_TOOLS.has(live.name)) return 'waiting';
        if (ACTING_TOOLS.has(live.name)) return 'acting';
        return 'thinking';
      }
      return null;
    }
    default:
      return null;
  }
}

/** Subgoal texts from a plan event (`step.ok` with `{type: 'plan', items}`), the active one first. */
export function planTexts(event: AgentEventLike): string[] | null {
  if (event.state !== 'step.ok') return null;
  const plan = parse(event.data?.details);
  if (!plan || plan.type !== 'plan' || !Array.isArray(plan.items)) return null;
  const items = plan.items as Array<{ text?: unknown; inProgress?: unknown; done?: unknown } | string>;
  const texts = items
    .map(it =>
      typeof it === 'string'
        ? { text: it, active: false, done: false }
        : {
            text: typeof it.text === 'string' ? it.text : '',
            active: it.inProgress === true,
            done: it.done === true,
          },
    )
    .filter(it => it.text && !it.done);
  texts.sort((a, b) => Number(b.active) - Number(a.active));
  return texts.map(t => t.text);
}

const STOP = new Set(
  (
    'the a an and or of to in on at for from by with about into over under is are be was were it its this that these those ' +
    'go open click find show get give tell make take use visit look search read summarize summarise compare check ' +
    'identify return report list choose pick select navigate scroll page pages site website post posts item items ' +
    'top thread most best first last one two today now please me my you your their there then than what which who ' +
    'how when where them they will would can could should also just only more less via using url urls http https www com ' +
    // Russian: verbs of the request, fillers, prepositions.
    'найди найти найдите открой открыть откройте зайди зайти перейди перейти нажми нажать кликни покажи показать посмотри ' +
    'посмотреть сделай сделать скажи сказать выбери выбрать проверь проверить сравни сравнить кратко перескажи ' +
    'самый самая самое самую самые лучший лучшая лучшее лучшую лучшие сегодня сейчас потом затем пожалуйста мне меня ' +
    'это этот эта эти тот та те там тут что как где когда который которая которые чтобы или для про при без над под ' +
    'из на по от до за через страницу страница сайт сайте пост посты ссылку ссылка'
  ).split(' '),
);

/**
 * The words worth looking for on a page: names and topic words from the
 * task and the subgoals, without verbs, fillers or URLs. Two-letter tokens
 * only when written in capitals (AI, UX). Plurals are trimmed so that a
 * prefix match finds both forms. At most `max`, in order of appearance.
 */
export function focusWords(texts: string[], max = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const raw of text.split(/[^A-Za-z0-9\u00C0-\u024F\u0400-\u04FF.+#-]+/)) {
      if (!raw || /\.\w/.test(raw) || /^\d+$/.test(raw)) continue;
      const token = raw.replace(/[.-]+$/, '');
      const lower = token.toLowerCase();
      if (STOP.has(lower)) continue;
      const capitals = token === token.toUpperCase() && /[A-Za-z\u0400-\u04FF]/.test(token);
      if (token.length < 3 && !(token.length === 2 && capitals)) continue;
      const stem = lower.length > 4 && lower.endsWith('s') && !lower.endsWith('ss') ? lower.slice(0, -1) : lower;
      if (seen.has(stem)) continue;
      seen.add(stem);
      out.push(stem);
      if (out.length >= max) return out;
    }
  }
  return out;
}

function parse(details: string | undefined): Record<string, unknown> | null {
  if (!details || details[0] !== '{') return null;
  try {
    return JSON.parse(details) as Record<string, unknown>;
  } catch {
    return null;
  }
}
