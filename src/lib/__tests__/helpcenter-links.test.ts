import { describe, expect, it } from "vitest";

import { extractLinks, parseHelpcenterLink } from "../helpcenter-links";

const hosts = ["guide.example.fr", "localhost:8990"];
const parse = (href: string, basePath = "") =>
  parseHelpcenterLink(href, "guide.example.fr", hosts, basePath);

describe("parseHelpcenterLink", () => {
  it("parses absolute links to a configured host", () => {
    expect(parse("https://guide.example.fr/fichiers/prise-en-main/mes-premiers-pas/")).toEqual({
      host: "guide.example.fr",
      collection: "fichiers",
      path: "prise-en-main/mes-premiers-pas",
    });
  });

  it("resolves root-relative links against the source host, ignoring query and hash", () => {
    expect(parse("/fichiers/mes-premiers-pas?x=1#etape-2")).toEqual({
      host: "guide.example.fr",
      collection: "fichiers",
      path: "mes-premiers-pas",
    });
  });

  it("matches hosts configured with a port", () => {
    expect(parse("http://localhost:8990/docs/page")?.host).toBe("localhost:8990");
  });

  it("ignores external links, anchors, mailto and CMS interlinks", () => {
    expect(parse("https://example.com/fichiers/page")).toBeNull();
    expect(parse("#section")).toBeNull();
    expect(parse("mailto:aide@example.fr")).toBeNull();
    expect(parse("/docs/3f2a1b4c-0000-4000-8000-1234567890ab/")).toBeNull();
  });

  it("treats non-collection routes as such", () => {
    expect(parse("/")).toEqual({ host: "guide.example.fr", collection: "", path: "" });
    expect(parse("/draft?docs=abc")?.collection).toBe("");
  });

  it("strips the base path", () => {
    expect(parse("/aide/fichiers/page", "/aide")?.collection).toBe("fichiers");
    expect(parse("/autre/fichiers/page", "/aide")).toBeNull();
  });
});

describe("extractLinks", () => {
  it("returns hrefs (unescaped) with their text", () => {
    expect(
      extractLinks('<p><a class="x" href="/a?b=1&amp;c=2"><strong>Voir</strong></a></p>'),
    ).toEqual([{ href: "/a?b=1&c=2", text: "Voir" }]);
  });
});
