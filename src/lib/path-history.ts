import { flattenPages, type PageItem } from "./collection-tree";
import { getRedis } from "./redis";

// Page URLs are derived from the page title (see buildPageItem), so renaming a
// page in the CMS changes its URL and every link pointing at the old one would
// 404. To keep those links alive we remember, per site + collection, every
// path we have ever served and the doc id it belonged to. An unknown path is
// then looked up here and redirected to the page's current URL.
//
// Stored as one Redis hash per collection: field = path, value = doc id. When
// a path gets reused by another page, the latest mapping wins. No TTL: old
// links can live in the wild indefinitely, and the hash stays small.
const PREFIX = "pathhistory:";

const keyFor = (host: string, collectionSlug: string) => `${PREFIX}${host}:${collectionSlug}`;

export async function recordPaths(
  host: string,
  collectionSlug: string,
  sections: PageItem[],
): Promise<void> {
  const pages = flattenPages(sections);
  if (pages.length === 0) return;
  const mapping: Record<string, string> = {};
  for (const page of pages) mapping[page.path] = page.id;
  try {
    await getRedis().hset(keyFor(host, collectionSlug), mapping);
  } catch (e) {
    console.warn(
      `recordPaths failed for ${host}/${collectionSlug}:`,
      e instanceof Error ? e.message : e,
    );
  }
}

export async function lookupPageIdByPath(
  host: string,
  collectionSlug: string,
  path: string,
): Promise<string | null> {
  try {
    return await getRedis().hget(keyFor(host, collectionSlug), path);
  } catch (e) {
    console.warn(
      `lookupPageIdByPath failed for ${host}/${collectionSlug}:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}
