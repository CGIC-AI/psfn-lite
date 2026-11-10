/**
 * What the companion sends on her own (the donor's outbound sender: scheduled
 * outreach, replies outside a request), kept in order for the conversation
 * transport's event stream. The log is in memory and bounded: a reader names
 * the last sequence number it saw and gets everything after it that is still
 * held, so a host that connects after the companion started, or reconnects,
 * misses nothing the log still holds. It reports the oldest sequence it can
 * serve, so a reader can tell when it did miss events.
 */
export interface OutboundEvent {
  /** Position in this process's log, from 1. A restart starts again at 1 under a new `epoch`. */
  readonly seq: number;
  readonly channelId: string;
  readonly content: string;
  /** Milliseconds since the Unix epoch. */
  readonly at: number;
}

export interface ConversationOutbox {
  /** Names this process's log; sequence numbers of another epoch do not continue here. */
  readonly epoch: string;
  publish(channelId: string, content: string): OutboundEvent;
  /** The held events after `after`, in order. */
  since(after: number): readonly OutboundEvent[];
  /** The sequence of the oldest held event, or the next sequence when none is held. */
  oldest(): number;
  /** Calls `listener` for every later event until the returned function is called. */
  subscribe(listener: (event: OutboundEvent) => void): () => void;
}

export function createConversationOutbox(input: { readonly capacity: number; readonly epoch: string; readonly now?: () => number }): ConversationOutbox {
  if (!Number.isInteger(input.capacity) || input.capacity < 1) throw new Error('outbox capacity must be a positive integer');
  const now = input.now ?? Date.now;
  const held: OutboundEvent[] = [];
  const listeners = new Set<(event: OutboundEvent) => void>();
  let next = 1;
  return {
    epoch: input.epoch,
    publish: (channelId, content) => {
      const event: OutboundEvent = Object.freeze({ seq: next, channelId, content, at: now() });
      next += 1;
      held.push(event);
      if (held.length > input.capacity) held.shift();
      for (const listener of [...listeners]) listener(event);
      return event;
    },
    since: (after) => held.filter((event) => event.seq > after),
    oldest: () => held[0]?.seq ?? next,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
