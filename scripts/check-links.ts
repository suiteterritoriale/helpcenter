/**
 * Checks the links written in CMS content across all configured
 * sites/collections and reports the ones that are broken:
 *
 * - CMS interlinks (`<a href="/docs/UUID/">`) whose UUID doesn't resolve to a
 *   page in the same collection's tree — the exact resolution SSR does (see
 *   rewriteAllInterlinks in src/pages/[collection]/[[...page]].tsx), so such a
 *   link would render stripped in production.
 * - Links to helpcenter URLs (`https://<configured host>/<collection>/<path>`
 *   or `/<collection>/<path>`) that no longer match a page. These URLs are
 *   derived from page titles, so they break when the target page is renamed
 *   or moved. When the path history (see src/lib/path-history.ts) knows the
 *   page, its current URL is suggested. Such links are better replaced by a
 *   CMS interlink, which survives renames.
 *
 * Usage: npm run check-links
 */

if (!process.env.DOCS_CMS_URL) {
  throw new Error("DOCS_CMS_URL environment variable is required");
}

import { buildPageItem, findPageById, findPageByPath, PageItem } from "../src/lib/collection-tree";
import { DocsChild } from "../src/lib/docs2dsfr/client";
import { getDocumentChildren } from "../src/lib/docs2dsfr/server";
import { extractLinks, parseHelpcenterLink } from "../src/lib/helpcenter-links";
import { lookupPageIdByPath } from "../src/lib/path-history";
import { closeRedis } from "../src/lib/redis";
import { allSites, type Site } from "../src/lib/sites";

// A dedicated, fully sequential tree walk for this script only — deliberately
// not reusing buildSectionTree. buildSectionTree recurses with Promise.all at
// every level, which (now that it's unbounded-depth) eagerly kicks off every
// sibling's entire subtree walk in parallel — thousands of pending call
// frames/timers all at once for a large collection, even though the actual
// network concurrency is throttled via DOCS_FETCH_CONCURRENCY. That appears
// to be what was causing widespread request failures during a full-tree
// crawl. This walker instead awaits one node's full subtree before moving to
// its sibling, so at most one branch is ever in flight.
async function buildTreeSequentially(
  rootId: string,
  forceRefresh: boolean,
  noCache: boolean,
): Promise<DocsChild[]> {
  const fetchDescendants = async (item: DocsChild): Promise<void> => {
    try {
      item.children = await getDocumentChildren(item.id, forceRefresh, noCache);
    } catch (e) {
      console.warn(`children fetch failed for ${item.id}:`, e instanceof Error ? e.message : e);
      item.children = [];
      return;
    }
    for (const child of item.children) {
      await fetchDescendants(child);
    }
  };

  const rawSections = (await getDocumentChildren(rootId, forceRefresh, noCache)).filter(
    (s) => s.title !== "_drafts",
  );
  for (const section of rawSections) {
    await fetchDescendants(section);
  }
  return rawSections;
}

interface BrokenLink {
  kind: "interlink" | "url";
  site: string;
  collection: string;
  sourceTitle: string;
  sourceUrl: string;
  // Missing doc UUID (interlink) or dead helpcenter URL (url).
  target: string;
  linkText: string;
  // Current URL of the target page, when it could be recovered.
  suggestion?: string;
}

// Trees of every collection, keyed by `${host}/${collectionSlug}`. A value of
// null means the collection exists but its tree couldn't be fetched, so links
// into it can't be verified.
type Trees = Map<string, PageItem[] | null>;

const treeKey = (host: string, collectionSlug: string) => `${host}/${collectionSlug}`;

const INTERLINK_RE = /<a\b[^>]*?\bhref="\/docs\/([0-9a-f-]+)\/?"[^>]*?>([\s\S]*?)<\/a>/gi;

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").trim();
}

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";
const urlOf = (collectionSlug: string, path: string) =>
  `${BASE_PATH}/${collectionSlug}${path ? `/${path}` : ""}`;

function findBrokenInterlinks(
  html: string,
  sections: PageItem[],
  base: Omit<BrokenLink, "kind" | "target" | "linkText">,
): BrokenLink[] {
  const broken: BrokenLink[] = [];
  for (const match of html.matchAll(INTERLINK_RE)) {
    if (!findPageById(sections, match[1])) {
      broken.push({ ...base, kind: "interlink", target: match[1], linkText: stripTags(match[2]) });
    }
  }
  return broken;
}

async function findBrokenUrls(
  html: string,
  trees: Trees,
  base: Omit<BrokenLink, "kind" | "target" | "linkText">,
): Promise<BrokenLink[]> {
  const broken: BrokenLink[] = [];
  for (const { href, text } of extractLinks(html)) {
    const target = parseHelpcenterLink(href, base.site, allSites.keys(), BASE_PATH);
    if (!target || !target.collection) continue;

    const key = treeKey(target.host, target.collection);
    if (!trees.has(key)) {
      // Unknown collection slug: the whole URL 404s.
      broken.push({ ...base, kind: "url", target: href, linkText: text });
      continue;
    }
    const sections = trees.get(key);
    if (!sections) continue; // tree unavailable — can't tell, don't report
    if (!target.path || findPageByPath(sections, target.path)) continue;

    let suggestion: string | undefined;
    const previousId = await lookupPageIdByPath(target.host, target.collection, target.path);
    const current = previousId ? findPageById(sections, previousId) : null;
    if (current) {
      const sameHost = target.host === base.site;
      suggestion = `${sameHost ? "" : `https://${target.host}`}${urlOf(target.collection, current.path)}`;
    }
    broken.push({ ...base, kind: "url", target: href, linkText: text, suggestion });
  }
  return broken;
}

// forceRefresh=false, noCache=false: reuse the same Redis-backed docs cache
// SSR and the reindex cron already keep warm, instead of forcing a fresh
// live CMS fetch for every single node. When Redis is cold or unreachable
// this degrades gracefully to a live fetch per node, so it's still correct
// everywhere — just far lighter on the CMS when the cache is actually warm.
// Set CHECK_LINKS_FRESH=1 to force a full live crawl bypassing the cache.
const FORCE_REFRESH = process.env.CHECK_LINKS_FRESH === "1";

async function fetchTrees(site: Site, trees: Trees): Promise<void> {
  for (const collection of site.collections) {
    console.log(`  Fetching collection: ${collection.title} (${collection.slug})`);
    try {
      const rawSections = await buildTreeSequentially(collection.docsId, FORCE_REFRESH, false);
      trees.set(
        treeKey(site.host, collection.slug),
        rawSections.map((s) => buildPageItem(s)),
      );
    } catch (e) {
      trees.set(treeKey(site.host, collection.slug), null);
      console.error(
        `Failed to fetch collection ${collection.slug} (${collection.docsId}):`,
        e instanceof Error ? e.message : e,
      );
    }
  }
}

async function checkSite(site: Site, trees: Trees): Promise<BrokenLink[]> {
  const broken: BrokenLink[] = [];
  for (const collection of site.collections) {
    const sections = trees.get(treeKey(site.host, collection.slug));
    if (!sections) continue;
    const visit = async (item: PageItem) => {
      const html = item.document?.content;
      if (html) {
        const base = {
          site: site.host,
          collection: collection.slug,
          sourceTitle: item.title,
          sourceUrl: urlOf(collection.slug, item.path),
        };
        broken.push(...findBrokenInterlinks(html, sections, base));
        broken.push(...(await findBrokenUrls(html, trees, base)));
      }
      for (const child of item.children) await visit(child);
    };
    for (const section of sections) await visit(section);
  }
  return broken;
}

function formatLink(link: BrokenLink): string {
  const source = `[${link.site}/${link.collection}] "${link.sourceTitle}" (${link.sourceUrl})`;
  const label = link.linkText ? ` — link text: "${link.linkText}"` : "";
  if (link.kind === "interlink") return `${source} → missing doc ${link.target}${label}`;
  const fix = link.suggestion ? `\n    page now at: ${link.suggestion}` : "";
  return `${source} → dead URL ${link.target}${label}${fix}`;
}

async function run() {
  console.log("Checking internal links...");
  console.log(`CMS URL: ${process.env.DOCS_CMS_URL}`);
  console.log(`Sites configured: ${allSites.size}`);

  if (allSites.size === 0) {
    throw new Error("No sites configured. Set HELPCENTER_SITES env var.");
  }

  const allBroken: BrokenLink[] = [];
  try {
    // Fetch every tree first: a link can point to another collection or site.
    const trees: Trees = new Map();
    for (const site of allSites.values()) {
      console.log(`\n=== Fetching site: ${site.host} ===`);
      await fetchTrees(site, trees);
    }
    for (const site of allSites.values()) {
      console.log(`\n=== Checking site: ${site.host} ===`);
      allBroken.push(...(await checkSite(site, trees)));
    }
  } finally {
    await closeRedis();
  }

  if (allBroken.length === 0) {
    console.log("\nNo broken internal links found.");
    return;
  }

  const interlinks = allBroken.filter((l) => l.kind === "interlink");
  const urls = allBroken.filter((l) => l.kind === "url");
  if (interlinks.length > 0) {
    console.log(`\nFound ${interlinks.length} broken doc interlink(s):\n`);
    for (const link of interlinks) console.log(formatLink(link));
  }
  if (urls.length > 0) {
    console.log(
      `\nFound ${urls.length} dead helpcenter URL(s) — page renamed, moved or deleted. ` +
        `Prefer replacing them with a Docs interlink, which survives renames:\n`,
    );
    for (const link of urls) console.log(formatLink(link));
  }
  process.exitCode = 1;
}

run().catch((err) => {
  console.error("check-links failed:", err);
  process.exit(1);
});
