// Helpers to spot links written in CMS content that point at helpcenter URLs
// (absolute `https://<configured host>/<collection>/<path>` or root-relative
// `/<collection>/<path>`), as opposed to CMS interlinks (`/docs/UUID/`).
// Those URLs are derived from page titles, so they break when a page is
// renamed — check-links uses these helpers to report them.

export interface HelpcenterLinkTarget {
  host: string;
  // "" for the site root and non-collection routes listed in SITE_ROUTES.
  collection: string;
  // Page path inside the collection ("" for the collection landing page).
  path: string;
}

// Top-level routes that are not collections (see src/pages).
const SITE_ROUTES = new Set(["", "draft", "healthz", "api", "404", "500"]);

const ANCHOR_RE = /<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;

export interface ContentLink {
  href: string;
  text: string;
}

export function extractLinks(html: string): ContentLink[] {
  const out: ContentLink[] = [];
  for (const match of html.matchAll(ANCHOR_RE)) {
    out.push({
      href: match[1].replace(/&amp;/g, "&"),
      text: match[2].replace(/<[^>]+>/g, "").trim(),
    });
  }
  return out;
}

/**
 * Returns where `href` points inside the helpcenter, or null when it is not a
 * helpcenter link (external site, CMS interlink, anchor, mailto, …).
 * Relative links resolve against `sourceHost`; absolute links only count when
 * their host is one of `knownHosts`.
 */
export function parseHelpcenterLink(
  href: string,
  sourceHost: string,
  knownHosts: Iterable<string>,
  basePath = "",
): HelpcenterLinkTarget | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  let url: URL;
  try {
    // Base only applies to relative hrefs; protocol is irrelevant here.
    url = new URL(trimmed, `https://${sourceHost}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const hosts = new Set(knownHosts);
  // Hosts in HELPCENTER_SITES may include a port (e.g. "localhost:8990").
  const host = hosts.has(url.host) ? url.host : hosts.has(url.hostname) ? url.hostname : null;
  if (!host) return null;

  let pathname = url.pathname;
  const base = basePath.replace(/\/$/, "");
  if (base) {
    if (pathname !== base && !pathname.startsWith(`${base}/`)) return null;
    pathname = pathname.slice(base.length);
  }

  let segments: string[];
  try {
    segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  // CMS interlinks are handled (and checked) separately.
  if (segments[0] === "docs" && /^[0-9a-f-]{36}$/i.test(segments[1] || "")) return null;

  const [first = "", ...rest] = segments;
  if (SITE_ROUTES.has(first)) return { host, collection: "", path: "" };
  return { host, collection: first, path: rest.join("/") };
}
