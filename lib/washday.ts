/* Wash-day allocation — client-safe constants and pure helpers only. No `db`
   import here: this file is pulled into client bundles (e.g. OrderClient.tsx),
   and importing lib/db would drag Prisma into the browser build. DB-touching
   logic (assignment, distribution) lives in lib/washday-server.ts. */

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** For the staff accept-order screen: is today NOT this student's assigned day? */
export function isOffWashDay(washDay: number | null, now = new Date()): boolean {
  if (washDay === null || washDay === undefined) return false;
  const ist = new Date(now.getTime() + 5.5 * 3600_000);
  return ist.getUTCDay() !== washDay;
}
