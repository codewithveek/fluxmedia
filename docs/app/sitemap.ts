import fs from "fs";
import path from "path";
import type { MetadataRoute } from "next";

const docsUrl = process.env.NEXT_PUBLIC_DOCS_URL ?? "https://docs.fluxmedia.dev";
const contentDir = path.join(process.cwd(), "content");

function readMeta(filePath: string): Record<string, string> | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as Record<string, string>;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const rootMeta = readMeta(path.join(contentDir, "_meta.json"));
  const providersMeta = readMeta(
    path.join(contentDir, "providers", "_meta.json")
  );

  const routes = new Set<string>();

  if (rootMeta) {
    Object.keys(rootMeta).forEach((key) => {
      routes.add(key === "index" ? "" : `/${key}`);
    });
  } else {
    ["", "/getting-started", "/providers", "/plugins", "/react", "/api"].forEach(
      (route) => routes.add(route)
    );
  }

  if (providersMeta) {
    Object.keys(providersMeta).forEach((key) => {
      routes.add(key === "index" ? "/providers" : `/providers/${key}`);
    });
  }

  return Array.from(routes).map((route) => ({
    url: `${docsUrl}${route}`,
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority: route === "" ? 1 : 0.7,
  }));
}
