/* Per-college feature flags — one definition, one meaning.

   Each college carries a `features` JSON map, and the platform reads it in
   four places: the student home screen, the place-order screen, the server
   action that accepts an order, and the admin toggle list. Those four had
   drifted into three different readings of the same absent key:

     student home      features[key]           -> missing = OFF (service hidden)
     place-order       features[key] !== false -> missing = ON
     acceptOrder       features[key] === false -> missing = ON  (allowed)
     admin toggles     features[key] !== false -> missing = ON  (shown enabled)

   So a college whose map lacked a key showed the service as enabled to an
   admin and accepted it server-side, while the student it was meant for
   could not see it at all. That is exactly what happened to Wash & Fold:
   DEFAULT_FEATURES never included `svc_washfold`, so every campus created
   through Add College launched without it — and Bronze is 34 Wash & Fold
   cycles, so those students would have bought a plan whose only service was
   invisible.

   The fix is not to pick one blanket default. `express` must stay off when
   unset and `svc_wash` must stay on, so the fallback is per key — the same
   defaults the requirements brief specifies. An explicit boolean in the map
   always wins; anything else falls back to the documented default. */

export const FEATURE_DEFAULTS = {
  svc_wash: true,
  svc_washfold: true,
  svc_iron: true,
  svc_dryclean: true,
  subscriptions: true,
  credits: true,
  chat: true,
  express: false,
} as const;

export type FeatureKey = keyof typeof FEATURE_DEFAULTS;

/** Which feature flag governs each order service. */
export const SERVICE_FEATURE: Record<string, FeatureKey> = {
  washIron: "svc_wash",
  washFold: "svc_washfold",
  ironOnly: "svc_iron",
  dryClean: "svc_dryclean",
};

/**
 * Is `key` enabled for this college?
 * Only a real boolean in the map counts; a missing or malformed value falls
 * back to that key's documented default rather than to a blanket true/false.
 */
export function featureOn(features: unknown, key: FeatureKey): boolean {
  const map = (features ?? {}) as Record<string, unknown>;
  const v = map[key];
  if (typeof v === "boolean") return v;
  // `?? false` matters at runtime even though the type says it cannot: these
  // keys arrive from JSON and from `as FeatureKey` casts, so an unknown one
  // would otherwise return undefined from a function declared to return
  // boolean — falsy in an `if`, but `undefined` in anything that renders it.
  return FEATURE_DEFAULTS[key] ?? false;
}

/** Is the order service enabled? Unknown services are never allowed. */
export function serviceOn(features: unknown, service: string): boolean {
  const key = SERVICE_FEATURE[service];
  return key ? featureOn(features, key) : false;
}
