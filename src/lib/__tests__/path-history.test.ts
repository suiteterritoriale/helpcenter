import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildPageItem } from "../collection-tree";

const store = new Map<string, Record<string, string>>();
vi.mock("../redis", () => ({
  getRedis: () => ({
    hset: async (key: string, mapping: Record<string, string>) => {
      store.set(key, { ...(store.get(key) || {}), ...mapping });
    },
    hget: async (key: string, field: string) => store.get(key)?.[field] ?? null,
  }),
}));

const { lookupPageIdByPath, recordPaths } = await import("../path-history");

const tree = (childTitle: string) => [
  buildPageItem({
    id: "section-1",
    title: "Fichiers",
    children: [{ id: "page-1", title: childTitle, children: [] }],
  } as never),
];

describe("path history", () => {
  beforeEach(() => store.clear());

  it("keeps resolving the old path of a renamed page to its id", async () => {
    await recordPaths("host", "guides", tree("Mes premiers pas"));
    await recordPaths("host", "guides", tree("Bien démarrer"));

    expect(await lookupPageIdByPath("host", "guides", "fichiers/mes-premiers-pas")).toBe("page-1");
    expect(await lookupPageIdByPath("host", "guides", "fichiers/bien-demarrer")).toBe("page-1");
    expect(await lookupPageIdByPath("host", "other", "fichiers/mes-premiers-pas")).toBeNull();
  });
});
