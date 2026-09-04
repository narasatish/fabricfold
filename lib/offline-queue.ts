/* Orders captured at the counter while the connection was down.

   The counter is the one place in this system that cannot wait. A student is
   standing there with a bag; "try again when the wifi is back" is not an
   answer, and campus wifi is exactly the thing that drops mid-queue.

   WHAT THIS DOES NOT DO, deliberately: it does not price the order, allocate a
   bag code, burn a plan cycle or issue an order number. All of those need the
   server — a cycle count and a gap-free code cannot be decided by a device
   that is out of touch with the others. What it stores is the INTAKE: who,
   what service, how many pieces. The server does the rest on replay, exactly
   as if the order had been typed a minute later.

   So the promise is narrow and honest: nothing the staff member typed is lost,
   and the order appears once the connection returns. It is not "the counter
   works fully offline".

   localStorage rather than IndexedDB: these records are a few hundred bytes,
   there are rarely more than a handful, and the whole value is that a reload
   or a crashed tab does not lose them. IndexedDB's async API would buy
   capacity this never needs. */

export type QueuedIntake = {
  /** Generated on the device. The server rejects a repeat, so a replay that
      fires twice cannot book the same bag in twice. */
  idemKey: string;
  studentId: string;
  studentLabel: string; // shown in the pending list; the counter needs a name, not an id
  service: string;
  cycles?: number; // cycle-based services: walkInOrder defaults this to 1 if omitted, so it must survive the replay
  items: { label: string; qty: number }[];
  weightKg: number | null;
  useCycle: boolean;
  noGst?: boolean;
  express?: boolean;
  capturedAt: number;
  /** Set when a replay failed for a reason retrying will not fix. */
  lastError?: string;
};

const KEY = "ff.offline.intakes";

/** crypto.randomUUID needs a secure context; every browser we support in one
    has it, but a plain fallback keeps this from throwing on an odd device. */
export function newIdemKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `ff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function read(): QueuedIntake[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as QueuedIntake[]) : [];
  } catch {
    /* Corrupt or truncated JSON. Returning [] rather than throwing keeps the
       counter usable; the alternative is a staff app that will not load
       because of one bad character in storage. */
    return [];
  }
}

function write(list: QueuedIntake[]) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch (e) {
    // quota, or private browsing with storage disabled
    console.error("[offline] could not persist intake queue:", (e as Error).message);
  }
}

export function listQueued(): QueuedIntake[] {
  return read().sort((a, b) => a.capturedAt - b.capturedAt); // oldest first: the queue is a queue
}

export function queueCount(): number {
  return read().length;
}

export function enqueueIntake(intake: Omit<QueuedIntake, "idemKey" | "capturedAt"> & { idemKey?: string }): QueuedIntake {
  const row: QueuedIntake = { ...intake, idemKey: intake.idemKey ?? newIdemKey(), capturedAt: Date.now() };
  write([...read(), row]);
  return row;
}

/** Remove one intake — called only after the server has confirmed the order. */
export function dequeueIntake(idemKey: string) {
  write(read().filter((r) => r.idemKey !== idemKey));
}

/** Record why a replay failed, keeping the intake queued for another try. */
export function markIntakeError(idemKey: string, error: string) {
  write(read().map((r) => (r.idemKey === idemKey ? { ...r, lastError: error.slice(0, 200) } : r)));
}

/**
 * Send everything queued, oldest first.
 *
 * `submit` is injected rather than imported so this module stays free of
 * server actions and can be unit-tested without a request scope.
 *
 * Stops at the first failure instead of ploughing on: if the connection is
 * still bad, the rest will fail too, and hammering a flaky link is how you
 * turn one timeout into ten. Order is preserved for the same reason a queue
 * is a queue — the first bag handed over should be the first booked in.
 */
export async function replayQueue(
  submit: (r: QueuedIntake) => Promise<{ ok: boolean; id?: string; error?: string }>,
): Promise<{ sent: number; failed: number; firstError?: string }> {
  let sent = 0, failed = 0, firstError: string | undefined;
  for (const row of listQueued()) {
    let res: { ok: boolean; id?: string; error?: string };
    try {
      res = await submit(row);
    } catch (e) {
      res = { ok: false, error: (e as Error).message };
    }
    if (res.ok) {
      dequeueIntake(row.idemKey);
      sent++;
    } else {
      markIntakeError(row.idemKey, res.error || "Unknown error");
      failed++;
      firstError ??= res.error;
      break;
    }
  }
  return { sent, failed, firstError };
}
