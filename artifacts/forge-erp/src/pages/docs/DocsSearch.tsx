import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useLocation } from "wouter";
import { Search, Loader2, X, FileText } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  getDocsIndex,
  searchDocs,
  type IndexedSection,
  type SearchResult,
} from "./searchIndex";

export function scrollToDocsSection(id: string) {
  let attempts = 0;
  const tryScroll = () => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (++attempts < 40) {
      setTimeout(tryScroll, 50);
    }
  };
  tryScroll();
}

export function DocsSearch() {
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [indexReady, setIndexReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);

  const indexRef = useRef<IndexedSection[] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ensureIndex = useCallback(async (): Promise<IndexedSection[] | null> => {
    if (indexRef.current) return indexRef.current;
    setLoading(true);
    try {
      const idx = await getDocsIndex();
      indexRef.current = idx;
      setIndexReady(true);
      setError(null);
      return idx;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load search index");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setHighlight(0);
      return;
    }
    let cancelled = false;
    ensureIndex().then((idx) => {
      if (cancelled || !idx) return;
      const r = searchDocs(trimmed, idx);
      setResults(r);
      setHighlight(0);
    });
    return () => {
      cancelled = true;
    };
  }, [query, ensureIndex]);

  useEffect(() => {
    function handler(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    function handler(e: globalThis.KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
        ensureIndex();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [ensureIndex]);

  const navigate = useCallback(
    (r: SearchResult) => {
      const path = `/docs/${r.section.guideSlug}`;
      const fullPath = `${path}#${r.section.sectionId}`;
      setLocation(fullPath);
      setOpen(false);
      setQuery("");
      setResults([]);
      inputRef.current?.blur();
      window.setTimeout(() => scrollToDocsSection(r.section.sectionId), 30);
    },
    [setLocation],
  );

  function handleKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      if (query) {
        setQuery("");
      } else {
        setOpen(false);
        inputRef.current?.blur();
      }
      return;
    }
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[highlight];
      if (r) navigate(r);
    }
  }

  const trimmed = query.trim();
  const showPanel = open && trimmed.length > 0;

  return (
    <div
      ref={containerRef}
      className="relative w-full max-w-md"
      data-testid="docs-search"
    >
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none" />
        <Input
          ref={inputRef}
          type="search"
          placeholder="Search docs…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            ensureIndex();
          }}
          onKeyDown={handleKeyDown}
          className="pl-8 pr-16 h-9"
          aria-label="Search documentation"
          autoComplete="off"
          spellCheck={false}
          data-testid="docs-search-input"
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
            data-testid="docs-search-clear"
          >
            <X className="size-4" />
          </button>
        ) : (
          <kbd
            className="hidden sm:inline-flex absolute right-2 top-1/2 -translate-y-1/2 items-center gap-0.5 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground pointer-events-none"
            aria-hidden="true"
          >
            ⌘K
          </kbd>
        )}
      </div>

      {showPanel && (
        <div
          className="absolute z-50 mt-1 w-full rounded-md border bg-popover text-popover-foreground shadow-lg max-h-[60vh] overflow-y-auto"
          role="listbox"
          data-testid="docs-search-results"
        >
          {loading && results.length === 0 && (
            <div
              className="flex items-center gap-2 p-3 text-sm text-muted-foreground"
              data-testid="docs-search-loading"
            >
              <Loader2 className="size-4 animate-spin" />
              Loading search index…
            </div>
          )}

          {error && !loading && (
            <div
              className="p-3 text-sm text-destructive"
              data-testid="docs-search-error"
            >
              {error}
            </div>
          )}

          {!loading &&
            !error &&
            indexReady &&
            results.length === 0 && (
              <div
                className="p-3 text-sm text-muted-foreground"
                data-testid="docs-search-empty"
              >
                No matches for &ldquo;{trimmed}&rdquo;.
              </div>
            )}

          {results.map((r, i) => (
            <button
              key={`${r.section.guideSlug}-${r.section.sectionId}`}
              type="button"
              role="option"
              aria-selected={i === highlight}
              onClick={() => navigate(r)}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                "w-full text-left px-3 py-2 border-b last:border-b-0 block transition-colors",
                i === highlight
                  ? "bg-accent text-accent-foreground"
                  : "hover:bg-accent/50",
              )}
              data-testid={`docs-search-result-${i}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <div className="font-medium text-sm truncate">
                  {r.section.sectionTitle}
                </div>
                <div className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0">
                  <FileText className="size-3" />
                  <span className="truncate max-w-[10rem]">
                    {r.section.guideLabel}
                  </span>
                </div>
              </div>
              {r.snippet ? (
                <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                  {r.snippet.before}
                  <mark className="bg-yellow-200 dark:bg-yellow-900/60 text-foreground rounded px-0.5">
                    {r.snippet.match}
                  </mark>
                  {r.snippet.after}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground mt-1 line-clamp-2">
                  Matched in section title.
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
