import { describe, expect, it } from "vitest";
import { buildExcerpt, containsAllWords, rankResults, tokenize } from "../Search";

const page = (content: string, title = "") => ({
  id: "1",
  url: "/p",
  raw_url: "/p",
  excerpt: "",
  content,
  meta: { title },
});

describe("tokenize", () => {
  it("lowercases, strips accents and splits on punctuation", () => {
    expect(tokenize("Accès à l'Espace")).toEqual(["acces", "a", "l", "espace"]);
  });
});

describe("containsAllWords", () => {
  const words = tokenize("mot de passe");

  it("keeps pages containing every word", () => {
    expect(containsAllWords(page("Changer son mot de passe"), words)).toBe(true);
  });

  it("rejects pages matching only by prefix", () => {
    expect(containsAllWords(page("Le mot clé de votre passeport"), words)).toBe(false);
  });

  it("rejects pages missing a word", () => {
    expect(containsAllWords(page("Un mot de bienvenue"), words)).toBe(false);
  });

  it("matches words in the title, ignoring case and accents", () => {
    expect(containsAllWords(page("de", "Mot PASSE"), words)).toBe(true);
    expect(containsAllWords(page("Accès refusé"), tokenize("acces refuse"))).toBe(true);
  });
});

describe("buildExcerpt", () => {
  const words = tokenize("mot de passe");

  it("centers on the exact phrase", () => {
    const filler = "Le choix de la date de la session de formation de l'agent. ".repeat(4);
    expect(buildExcerpt(`${filler}Changer son mot de passe.`, words)).toContain(
      "<mark>mot</mark> <mark>de</mark> <mark>passe</mark>.",
    );
  });

  it("does not highlight stop words outside the phrase", () => {
    const excerpt = buildExcerpt("Le choix de la date de début : un mot simple, on passe.", words);
    expect(excerpt).not.toContain("<mark>de</mark>");
    expect(excerpt).toContain("<mark>mot</mark>");
    expect(excerpt).toContain("<mark>passe</mark>");
  });

  it("escapes HTML", () => {
    expect(buildExcerpt("Un <mot> & co", ["mot"])).toBe("Un &lt;<mark>mot</mark>&gt; &amp; co");
  });
});

describe("rankResults", () => {
  it("ranks exact-phrase matches first and drops partial matches", () => {
    const scattered = { ...page("Un mot, de la place, on passe."), id: "scattered" };
    const phrase = { ...page("Changer son mot de passe."), id: "phrase" };
    const partial = { ...page("Un mot de bienvenue."), id: "partial" };
    const ranked = rankResults([scattered, partial, phrase], tokenize("mot de passe"));
    expect(ranked.map((r) => r.id)).toEqual(["phrase", "scattered"]);
  });
});
