/**
 * The one seam between `Page` and anything that shows the agent's presence
 * on the page (today: the spider). `Page` calls these at its four inherent
 * choke points — a pointer action is about to happen, keys are typed, the
 * page is captured, the page navigates — plus attach/detach and scroll. It
 * does not know what implements them; the background wires an implementation
 * once at startup (`setPagePresence`). Implementations must be bounded and
 * must never throw: presence is decoration.
 */
export interface PresencePoint {
  x: number;
  y: number;
}

export interface PresenceRect extends PresencePoint {
  width: number;
  height: number;
}

export interface PagePresence {
  /** Is anything shown in this tab (lets `Page` skip work when not)? */
  showing(tabId: number): boolean;
  /** The agent attached to this tab. */
  attached(tabId: number): void;
  /** The agent detached from this tab. */
  detached(tabId: number): void;
  /** A click, a tap into a field or a drag start is about to land on `point` (viewport CSS px). */
  beforePointer(tabId: number, point: PresencePoint, rect?: PresenceRect): Promise<void>;
  /** Keys are being typed (true) or done (false). */
  typing(tabId: number, on: boolean): Promise<void>;
  /** The agent scrolls the page by about `dy` px. */
  scrolled(tabId: number, dy: number): void;
  /** The tab is about to navigate. */
  beforeNavigate(tabId: number): Promise<void>;
  /** A screenshot is about to be taken / was taken: nothing of the presence may be in it. */
  beforeCapture(tabId: number): Promise<void>;
  afterCapture(tabId: number): void;
}

const none: PagePresence = {
  showing: () => false,
  attached: () => {},
  detached: () => {},
  beforePointer: async () => {},
  typing: async () => {},
  scrolled: () => {},
  beforeNavigate: async () => {},
  beforeCapture: async () => {},
  afterCapture: () => {},
};

let current: PagePresence = none;

export function setPagePresence(presence: PagePresence | null): void {
  current = presence ?? none;
}

export function pagePresence(): PagePresence {
  return current;
}
