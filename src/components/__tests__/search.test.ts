import { describe, expect, it } from "vitest";
import { containsAllWords, tokenize } from "../Search";

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
