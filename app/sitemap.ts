import type { MetadataRoute } from "next";

const BASE = "https://fabricfold.in";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  // /login is deliberately excluded — it's a bare auth form (or an instant
  // redirect for a signed-in visitor), nothing a crawler should index.
  const pages = ["", "/how-it-works", "/hostel-laundry", "/partners", "/about", "/contact", "/privacy", "/terms", "/refunds"];
  return pages.map((p) => ({
    url: BASE + p,
    lastModified: now,
    changeFrequency: p === "" ? "weekly" : "monthly",
    priority: p === "" ? 1 : p === "/partners" ? 0.9 : 0.7,
  }));
}
