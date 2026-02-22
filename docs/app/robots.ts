import type { MetadataRoute } from "next";

const docsUrl = process.env.NEXT_PUBLIC_DOCS_URL ?? "https://docs.fluxmedia.dev";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    sitemap: `${docsUrl}/sitemap.xml`,
    host: docsUrl,
  };
}
