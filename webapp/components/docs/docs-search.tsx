'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DocsSearchProps {
  className?: string;
}

interface SearchItem {
  url: string;
  title: string;
  excerpt: string;
}

interface PagefindResult {
  data: () => Promise<{
    url: string;
    meta?: { title?: string };
    excerpt?: string;
  }>;
}

interface PagefindModule {
  options?: (options: { baseUrl?: string }) => Promise<void> | void;
  search: (query: string) => Promise<{ results: PagefindResult[] }>;
}

const MIN_QUERY_LENGTH = 2;

let pagefindPromise: Promise<PagefindModule | null> | null = null;

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadPagefindModule(): Promise<PagefindModule | null> {
  if (typeof window === 'undefined') {
    return null;
  }

  if (!pagefindPromise) {
    pagefindPromise = (async () => {
      try {
        const pf = await import(
          // @ts-expect-error — pagefind is generated at build time, not a real module
          /* webpackIgnore: true */ '/_pagefind/pagefind.js'
        );
        await pf.options?.({ baseUrl: '/' });
        return pf as PagefindModule;
      } catch {
        return null;
      }
    })();
  }

  return pagefindPromise;
}

export function DocsSearch({ className }: DocsSearchProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [results, setResults] = useState<SearchItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setIsOpen(true);
      }
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const timeout = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 10);

    return () => window.clearTimeout(timeout);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      setResults([]);
      setError(null);
      setIsLoading(false);
      return;
    }

    const normalizedQuery = query.trim();
    if (normalizedQuery.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setError(null);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    const debounceTimer = window.setTimeout(async () => {
      setIsLoading(true);
      setError(null);

      const pagefind = await loadPagefindModule();
      if (!pagefind) {
        if (!cancelled) {
          setResults([]);
          setError(
            'Search index is unavailable in dev mode. Run a production build once to generate it.'
          );
          setIsLoading(false);
        }
        return;
      }

      try {
        const searchResult = await pagefind.search(normalizedQuery);
        const topResults = searchResult.results.slice(0, 8);
        const resolvedResults = await Promise.all(
          topResults.map(async (result) => {
            const data = await result.data();
            // Pagefind returns .html URLs from the build output; strip the
            // extension so Next.js clean URLs resolve correctly.
            const cleanUrl = data.url.replace(/\.html$/, '').replace(/\/index$/, '') || '/';
            return {
              url: cleanUrl,
              title: data.meta?.title || cleanUrl,
              excerpt: stripHtml(data.excerpt || ''),
            };
          })
        );

        if (!cancelled) {
          setResults(resolvedResults);
          if (resolvedResults.length === 0) {
            setError('No matching pages found.');
          }
        }
      } catch {
        if (!cancelled) {
          setResults([]);
          setError('Search failed. Please try again.');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(debounceTimer);
    };
  }, [query, isOpen]);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={cn(
          'hidden h-9 items-center gap-2 rounded-lg border border-border/70 bg-card px-3 text-sm text-muted-foreground transition-colors hover:text-foreground lg:flex',
          className
        )}
      >
        <Search className="h-4 w-4" />
        <span>Search documentation...</span>
        <kbd className="ml-2 rounded border border-border/70 bg-background px-1.5 py-0.5 text-xs text-muted-foreground">
          Ctrl K
        </kbd>
      </button>

      {isOpen ? (
        <div
          className="fixed inset-0 z-90 bg-background/70 p-4 backdrop-blur-sm"
          onClick={() => setIsOpen(false)}
        >
          <div
            className="mx-auto mt-16 w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-popover shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Search className="h-4 w-4 text-muted-foreground" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search docs, blog, and API pages..."
                className="h-8 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
                <span className="sr-only">Close search</span>
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto p-2">
              {query.trim().length < MIN_QUERY_LENGTH ? (
                <p className="px-3 py-4 text-sm text-muted-foreground">
                  Type at least {MIN_QUERY_LENGTH} characters to search.
                </p>
              ) : null}

              {isLoading ? (
                <p className="px-3 py-4 text-sm text-muted-foreground">Searching...</p>
              ) : null}

              {!isLoading && error ? (
                <p className="px-3 py-4 text-sm text-muted-foreground">{error}</p>
              ) : null}

              {!isLoading && !error && results.length > 0
                ? results.map((result) => (
                    <Link
                      key={`${result.url}-${result.title}`}
                      href={result.url}
                      className="block rounded-lg px-3 py-3 transition-colors hover:bg-accent/60"
                      onClick={() => setIsOpen(false)}
                    >
                      <p className="text-sm font-medium text-foreground">{result.title}</p>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {result.excerpt || result.url}
                      </p>
                    </Link>
                  ))
                : null}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
