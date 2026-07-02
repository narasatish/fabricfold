/* In-process realtime pub/sub feeding SSE streams.
   Channels: `orders:{collegeId}` (staff) and `student:{studentId}` (customer).
   Single Next.js server process => an EventEmitter is sufficient; swap for
   Redis pub/sub if ever scaled horizontally. */
import { EventEmitter } from "node:events";

const g = globalThis as unknown as { __ffbus?: EventEmitter };
export const bus = g.__ffbus ?? new EventEmitter();
bus.setMaxListeners(0);
g.__ffbus = bus;

export type RtEvent = {
  type: string; // order.updated | order.created | notification | complaint.message | payment | subscription
  payload: Record<string, unknown>;
};

export function publish(channels: string[], ev: RtEvent) {
  for (const ch of channels) bus.emit(ch, ev);
}

export function orderChannels(o: { collegeId: string; studentId: string }) {
  return [`orders:${o.collegeId}`, `student:${o.studentId}`];
}
