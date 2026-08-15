/* Per-college feature flags.

   These exist because the same absent key used to mean three different things
   depending on which file read it, and the disagreement was invisible: the
   admin switch said a service was on, the server accepted it, and only the
   student — the one person who mattered — could not see it. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { FEATURE_DEFAULTS, FeatureKey, featureOn, SERVICE_FEATURE, serviceOn } from "../lib/features";

const read = (p: string) => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");

describe("featureOn", () => {
  it("an explicit boolean always wins over the default", () => {
    expect(featureOn({ svc_wash: false }, "svc_wash")).toBe(false); // default on
    expect(featureOn({ express: true }, "express")).toBe(true); // default off
  });

  it("falls back PER KEY, not to a blanket value", () => {
    // the whole point: one fallback couldn't serve both of these
    expect(featureOn({}, "svc_wash")).toBe(true);
    expect(featureOn({}, "express")).toBe(false);
  });

  it("treats a missing svc_washfold as ON", () => {
    // the original bug: DEFAULT_FEATURES omitted this key, so colleges added
    // through the UI hid Wash & Fold — the service Bronze is built on
    expect(featureOn({ svc_wash: true }, "svc_washfold")).toBe(true);
  });

  it("survives null, undefined and junk instead of throwing", () => {
    expect(featureOn(null, "svc_wash")).toBe(true);
    expect(featureOn(undefined, "svc_wash")).toBe(true);
    expect(featureOn("nonsense", "svc_wash")).toBe(true);
    // a non-boolean value is not a decision — fall back rather than coerce
    expect(featureOn({ express: "yes" }, "express")).toBe(false);
    expect(featureOn({ svc_wash: 0 }, "svc_wash")).toBe(true);
  });

  it("returns a real boolean for a key with no default, never undefined", () => {
    // keys reach this function from JSON and from `as FeatureKey` casts, so an
    // unknown one must not leak undefined out of a function typed `boolean`
    const rogue = "svc_teleport" as FeatureKey;
    expect(featureOn({}, rogue)).toBe(false);
    expect(typeof featureOn({}, rogue)).toBe("boolean");
  });
});

describe("serviceOn", () => {
  it("maps every order service to a flag", () => {
    for (const service of ["washIron", "washFold", "ironOnly", "dryClean"]) {
      expect(SERVICE_FEATURE[service]).toBeDefined();
      expect(serviceOn({}, service)).toBe(true);
    }
  });

  it("refuses an unknown service rather than defaulting it on", () => {
    expect(serviceOn({}, "sandblasting")).toBe(false);
    expect(serviceOn({}, "")).toBe(false);
  });

  it("honours a campus that has switched a service off", () => {
    expect(serviceOn({ svc_dryclean: false }, "dryClean")).toBe(false);
  });
});

describe("defaults cover everything", () => {
  it("every service flag has a default", () => {
    for (const key of Object.values(SERVICE_FEATURE)) {
      expect(FEATURE_DEFAULTS[key]).toBeDefined();
    }
  });

  it("a new college is stamped with EVERY key, so nothing is left implicit", () => {
    // the original defect was an omission from this literal, so assert the
    // admin action spreads the shared set rather than re-listing keys by hand
    const src = read("lib/actions/admin.ts");
    expect(src).toMatch(/DEFAULT_FEATURES = \{ \.\.\.FEATURE_DEFAULTS \}/);
    expect(src).toMatch(/features: DEFAULT_FEATURES/);
  });

  it("express is the only add-on that starts off", () => {
    const off = (Object.keys(FEATURE_DEFAULTS) as FeatureKey[]).filter((k) => !FEATURE_DEFAULTS[k]);
    expect(off).toEqual(["express"]);
  });
});

describe("no file reads the flags its own way any more", () => {
  const callers = [
    "app/c/page.tsx",
    "app/c/order/new/page.tsx",
    "lib/actions/orders.ts",
    "app/s/admin/_components/AdminClient.tsx",
  ];

  it("every caller goes through the shared helper", () => {
    for (const f of callers) {
      expect(read(f)).toMatch(/featureOn|serviceOn/);
    }
  });

  it("nobody hand-rolls the comparison again", () => {
    // `features[key] !== false` and `=== false` are exactly how the readings
    // drifted apart; they must not reappear
    for (const f of callers) {
      const src = read(f);
      expect(src).not.toMatch(/feat\[[^\]]+\]\s*[!=]==\s*false/);
      expect(src).not.toMatch(/features\[[^\]]+\]\s*[!=]==\s*false/);
    }
  });
});

describe("express is a money path", () => {
  it("the surcharge is gated on the resolved flag, not a raw lookup", () => {
    // an absent flag must never switch on a charge
    const src = read("lib/actions/orders.ts");
    expect(src).toMatch(/input\.express && featureOn\(/);
    expect(src).not.toMatch(/feat\.express !== false/);
  });
});
