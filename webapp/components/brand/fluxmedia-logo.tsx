import { cn } from '@/lib/utils';

type FluxMediaLogoMarkProps = {
  className?: string;
  title?: string;
};

type FluxMediaLogoProps = {
  className?: string;
  markClassName?: string;
  textClassName?: string;
  showText?: boolean;
};

export function FluxMediaLogoMark({ className, title = 'FluxMedia logo' }: FluxMediaLogoMarkProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      aria-hidden="true"
      role="img"
      className={cn('h-6 w-6', className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <title>{title}</title>
      <g stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 14L28 28" />
        <path d="M18 32H28" />
        <path d="M18 50L28 36" />
        <path d="M38 32H40" />
      </g>

      <circle cx="14" cy="14" r="4" fill="currentColor" />
      <circle cx="14" cy="32" r="4" fill="currentColor" />
      <circle cx="14" cy="50" r="4" fill="currentColor" />
      <circle cx="33" cy="32" r="5" fill="currentColor" />

      <circle cx="50" cy="32" r="10" stroke="currentColor" strokeWidth="4" />
      <path d="M47 27L55 32L47 37V27Z" fill="currentColor" />
    </svg>
  );
}

export function FluxMediaLogo({
  className,
  markClassName,
  textClassName,
  showText = true,
}: FluxMediaLogoProps) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <FluxMediaLogoMark className={cn('text-brand', markClassName)} />
      {showText ? (
        <span className={cn('font-bold text-base tracking-tight', textClassName)}>FluxMedia</span>
      ) : null}
    </span>
  );
}
