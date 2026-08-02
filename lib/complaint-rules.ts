/* Complaint rules shared by the server actions and the UI.

   Deliberately NOT in lib/actions/complaints.ts: a "use server" module may only
   export async functions, so a plain constant there silently invalidates every
   other export in the file. Same split as washday.ts / washday-server.ts. */

/* A damage report is evidence for a dispute about someone's clothes, so it has
   to stand on its own weeks later: at least this many photos, plus a written
   note of what staff actually saw. More photos are always allowed. */
export const MIN_DAMAGE_PHOTOS = 3;

/** Upper bound per message — a sanity cap, not a business rule. */
export const MAX_PHOTOS_PER_MESSAGE = 30;

export function cleanPhotos(photos?: string[] | null) {
  return (photos || [])
    .map((p) => String(p || "").trim())
    .filter(Boolean)
    .slice(0, MAX_PHOTOS_PER_MESSAGE);
}
