import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // session-scoped app screens and APIs have nothing for crawlers
        disallow: ["/c", "/c/", "/s", "/s/", "/api/"],
      },
    ],
    sitemap: "https://fabricfold.in/sitemap.xml",
  };
}
