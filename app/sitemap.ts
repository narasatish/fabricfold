import type { MetadataRoute } from "next";

const BASE = "https://fabricfold.in";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  const pages = ["", "/how-it-works", "/hostel-laundry", "/partners", "/about", "/contact", "/login", "/privacy", "/terms", "/refunds"];
  return pages.map((p) => ({
    url: BASE + p,
    lastModified: now,
    changeFrequency: p === "" ? "weekly" : "monthly",
    priority: p === "" ? 1 : p === "/partners" ? 0.9 : 0.7,
  }));
}
