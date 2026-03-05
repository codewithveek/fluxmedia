import Link from 'next/link';
import { ArrowLeft, ArrowRight } from 'lucide-react';

export interface PrevNextLink {
  href: string;
  title: string;
}

interface PrevNextNavProps {
  prev?: PrevNextLink | null;
  next?: PrevNextLink | null;
}

export function PrevNextNav({ prev, next }: PrevNextNavProps) {
  if (!prev && !next) return null;

  return (
    <nav className="mt-16 pt-8 border-t border-border/50 grid grid-cols-2 gap-4">
      {prev ? (
        <Link
          href={prev.href}
          className="group flex flex-col gap-1.5 rounded-lg border border-border/50 px-5 py-4 transition-colors hover:border-brand/40 hover:bg-brand/5"
        >
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" />
            Previous
          </span>
          <span className="text-sm font-semibold text-foreground group-hover:text-brand transition-colors line-clamp-1">
            {prev.title}
          </span>
        </Link>
      ) : (
        <div />
      )}

      {next ? (
        <Link
          href={next.href}
          className="group flex flex-col items-end gap-1.5 rounded-lg border border-border/50 px-5 py-4 transition-colors hover:border-brand/40 hover:bg-brand/5 text-right"
        >
          <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Next
            <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </span>
          <span className="text-sm font-semibold text-foreground group-hover:text-brand transition-colors line-clamp-1">
            {next.title}
          </span>
        </Link>
      ) : (
        <div />
      )}
    </nav>
  );
}
