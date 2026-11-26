import React, { useCallback, useEffect, useRef, useState } from "react";

interface SearchResult {
  id: string;
  url: string;
  raw_url: string;
  excerpt: string;
  content: string;
  meta: { title?: string; parent_title?: string };
}

const MAX_RESULTS = 8;
const MAX_CANDIDATES = 50;
const BATCH_SIZE = 10;

// Lowercase, strip accents and split on anything that isn't a letter or digit.
export function tokenize(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Pagefind matches terms by prefix ("passe" also finds "passeport"), so keep
// only pages that contain every word of the query as a whole word.
export function containsAllWords(result: SearchResult, words: string[]): boolean {
  const pageWords = new Set(
    tokenize(`${result.meta.parent_title ?? ""} ${result.meta.title ?? ""} ${result.content}`),
  );
  return words.every((w) => pageWords.has(w));
}

const EXCERPT_WORDS = 20;
const EXCERPT_LEAD = 5;

// Words too common to anchor an excerpt or deserve a highlight on their own.
const STOP_WORDS = new Set(
  "a au aux avec ce ces d dans de des du en et il l la le les leur ma mes mon ne ou par pas pour qu que qui sa se ses son sur ta un une vos votre y".split(
    " ",
  ),
);

interface Token {
  word: string;
  start: number;
  end: number;
}

function tokenizeWithOffsets(text: string): Token[] {
  return Array.from(text.matchAll(/[\p{L}\p{N}]+/gu), (m) => ({
    word: tokenize(m[0]).join(""),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

function phraseStarts(tokens: Token[], words: string[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i + words.length <= tokens.length; i++) {
    if (words.every((w, j) => tokens[i + j].word === w)) starts.push(i);
  }
  return starts;
}

export function containsPhrase(result: SearchResult, words: string[]): boolean {
  const text = `${result.meta.parent_title ?? ""} ${result.meta.title ?? ""} ${result.content}`;
  return phraseStarts(tokenizeWithOffsets(text), words).length > 0;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

// Pagefind centers its excerpt on the densest cluster of matches, which for
// "mot de passe" is often a run of "de". Center on the exact phrase instead,
// or else on the window holding the most distinct meaningful query words.
export function buildExcerpt(content: string, words: string[]): string {
  const tokens = tokenizeWithOffsets(content);
  if (tokens.length === 0) return "";
  const significant = new Set(words.filter((w) => !STOP_WORDS.has(w)));
  const highlight = significant.size > 0 ? significant : new Set(words);
  const marked = new Set<number>();
  const starts = words.length > 0 ? phraseStarts(tokens, words) : [];
  for (const s of starts) for (let j = 0; j < words.length; j++) marked.add(s + j);
  tokens.forEach((t, i) => highlight.has(t.word) && marked.add(i));

  let anchor = starts[0] ?? -1;
  if (anchor < 0) {
    let best = 0;
    for (let i = 0; i < tokens.length; i++) {
      const seen = new Set<string>();
      for (let j = i; j < Math.min(i + EXCERPT_WORDS, tokens.length); j++) {
        if (highlight.has(tokens[j].word)) seen.add(tokens[j].word);
      }
      if (seen.size > best) {
        best = seen.size;
        anchor = i;
      }
    }
  }
  const first = Math.max(0, anchor - EXCERPT_LEAD);
  const last = Math.min(tokens.length, first + EXCERPT_WORDS) - 1;

  let html = "";
  let pos = tokens[first].start;
  for (let i = first; i <= last; i++) {
    const t = tokens[i];
    html += escapeHtml(content.slice(pos, t.start));
    const text = escapeHtml(content.slice(t.start, t.end));
    html += marked.has(i) ? `<mark>${text}</mark>` : text;
    pos = t.end;
  }
  // Keep trailing punctuation of the last word (e.g. a final period).
  html += escapeHtml(content.slice(pos).match(/^[^\p{L}\p{N}\s]*/u)?.[0] ?? "");
  return html;
}

// Keep pages containing every query word, exact-phrase matches first, with an
// excerpt showing why each page matched.
export function rankResults(results: SearchResult[], words: string[]): SearchResult[] {
  const matching = results.filter((r) => containsAllWords(r, words));
  const phrase = matching.filter((r) => containsPhrase(r, words));
  const others = matching.filter((r) => !phrase.includes(r));
  return [...phrase, ...others].map((r) => ({ ...r, excerpt: buildExcerpt(r.content, words) }));
}

interface Pagefind {
  options: (opts: Record<string, unknown>) => Promise<void>;
  search: (query: string) => Promise<{
    results: Array<{ id: string; data: () => Promise<SearchResult> }>;
  }>;
}

let pagefindInstance: Pagefind | null = null;
let pagefindLoading = false;

async function getPagefind(): Promise<Pagefind | null> {
  if (pagefindInstance) return pagefindInstance;
  if (pagefindLoading) return null;
  pagefindLoading = true;
  try {
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
    const pf = await import(/* webpackIgnore: true */ `${basePath}/api/pagefind/pagefind.js`);
    await pf.options({ excerptLength: 20 });
    pagefindInstance = pf;
    return pf;
  } catch {
    return null;
  } finally {
    pagefindLoading = false;
  }
}

export function useSearch() {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // DSFR's Header caches renderSearchInput, so onKeyDown's closure can go stale.
  // Read the latest state through refs instead.
  const resultsRef = useRef(results);
  const activeIndexRef = useRef(activeIndex);
  const openRef = useRef(open);
  useEffect(() => {
    resultsRef.current = results;
  }, [results]);
  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // Preload pagefind on mount
  useEffect(() => {
    getPagefind();
  }, []);

  // Focus the search input when the DSFR mobile search modal is opened.
  useEffect(() => {
    const btn = document.getElementById("fr-header-search-button");
    if (!btn) return;
    const handleClick = () =>
      setTimeout(() => document.getElementById("fr-header-search-input")?.focus(), 300);
    btn.addEventListener("click", handleClick);
    return () => btn.removeEventListener("click", handleClick);
  }, []);

  // Track the last successfully-searched query so we only reset activeIndex when new results arrive
  const lastSearchedRef = useRef<string>("");

  const doSearch = useCallback(async (q: string) => {
    const pf = await getPagefind();
    if (!pf || !q.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    setLoading(true);
    try {
      const search = await pf.search(q);
      const words = tokenize(q);
      const candidates = search.results.slice(0, MAX_CANDIDATES);
      const fetched: SearchResult[] = [];
      let phraseMatches = 0;
      // Phrase matches rank first, so keep fetching until we have enough of them.
      for (let i = 0; i < candidates.length && phraseMatches < MAX_RESULTS; i += BATCH_SIZE) {
        const batch = await Promise.all(candidates.slice(i, i + BATCH_SIZE).map((r) => r.data()));
        fetched.push(...batch);
        phraseMatches += batch.filter(
          (r) => containsAllWords(r, words) && containsPhrase(r, words),
        ).length;
      }
      const data = rankResults(fetched, words).slice(0, MAX_RESULTS);
      if (lastSearchedRef.current !== q) {
        setActiveIndex(0);
        lastSearchedRef.current = q;
      }
      setResults(data);
      setOpen(data.length > 0 || q.trim().length > 0);
    } catch {
      setResults([]);
    }
    setLoading(false);
  }, []);

  const search = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!value.trim()) {
        setResults([]);
        setOpen(false);
        lastSearchedRef.current = "";
        setActiveIndex(0);
        return;
      }
      debounceRef.current = setTimeout(() => doSearch(value), 200);
    },
    [doSearch],
  );

  const close = useCallback(() => setOpen(false), []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    const curResults = resultsRef.current;
    if (!openRef.current || curResults.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % curResults.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i - 1 + curResults.length) % curResults.length);
    } else if (e.key === "Enter") {
      const target = curResults[activeIndexRef.current];
      if (target) {
        // Stop DSFR's Header from also firing onSearchButtonClick, which resets activeIndex.
        e.preventDefault();
        e.stopPropagation();
        window.location.href = target.raw_url;
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }, []);

  return { results, loading, open, query, activeIndex, search, close, onKeyDown, setActiveIndex };
}

export function SearchResults({
  results,
  query,
  loading,
  open,
  activeIndex,
  onClose,
  onHoverIndex,
}: {
  results: SearchResult[];
  query: string;
  loading: boolean;
  open: boolean;
  activeIndex: number;
  onClose: () => void;
  onHoverIndex: (i: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({});

  // Keep the DSFR search bar visible at any viewport width while results are open.
  useEffect(() => {
    document.body.classList.toggle("helpcenter-search-open", open);
    return () => document.body.classList.remove("helpcenter-search-open");
  }, [open]);

  // When the viewport crosses below the DSFR desktop breakpoint while search is
  // open, close the dropdown and focus the mobile search input.
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia("(max-width: 61.9999em)");
    const handleChange = (e: MediaQueryListEvent) => {
      if (e.matches) {
        onClose();
        document.getElementById("fr-header-search-button")?.click();
        setTimeout(() => document.getElementById("fr-header-search-input")?.focus(), 300);
      }
    };
    mq.addEventListener("change", handleChange);
    return () => mq.removeEventListener("change", handleChange);
  }, [open, onClose]);

  // Position dropdown under the search bar. Use absolute (document) coordinates
  // so the dropdown scrolls with the search bar instead of floating in the viewport.
  useEffect(() => {
    if (!open) return;
    const searchBar = document.querySelector(".fr-header .fr-search-bar");
    if (!searchBar) return;
    const update = () => {
      const rect = searchBar.getBoundingClientRect();
      setStyle({
        position: "absolute",
        top: rect.bottom + window.scrollY,
        left: rect.left + window.scrollX,
        width: Math.max(rect.width, 400),
      });
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [open, results]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    if (open) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div ref={ref} className="helpcenter-search-results-container" style={style}>
      {results.length > 0 ? (
        <ul className="helpcenter-search-results">
          {results.map((r, i) => (
            <li
              key={`${i}-${r.id}`}
              className={i === activeIndex ? "helpcenter-search-active" : undefined}
              onMouseMove={() => {
                if (i !== activeIndex) onHoverIndex(i);
              }}
            >
              <a href={r.raw_url} onClick={onClose}>
                <strong>
                  {r.meta.parent_title ? `${r.meta.parent_title} > ` : ""}
                  {r.meta.title || r.raw_url}
                </strong>
                {/* Pagefind sanitizes excerpt content and only injects <mark> highlight tags. */}
                <span dangerouslySetInnerHTML={{ __html: r.excerpt }} />
              </a>
            </li>
          ))}
        </ul>
      ) : query && !loading ? (
        <div className="helpcenter-search-results helpcenter-search-empty">
          Aucun résultat pour &laquo;&nbsp;{query}&nbsp;&raquo;
        </div>
      ) : null}
    </div>
  );
}
