import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { ArrowLeft, Clock } from 'lucide-react';

interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  features?: string[];
  fixes?: string[];
  improvements?: string[];
}

const changelog: ChangelogEntry[] = [
  {
    version: 'v2.0.0',
    date: 'Mar 5, 2026',
    title: 'Retry Resume & Stream Uploads',
    features: [
      'PartialUploadError support — resume uploads from the last known state',
      'withRetry now accepts an optional resumeContext parameter for retry attempts',
      'R2 and S3 providers accept UploadInput (streams) in upload methods',
      'Multipart uploads retain parts for potential resume when retry is enabled',
      'Content type detection based on input type, skipping magic-byte detection for streams',
    ],
    improvements: [
      'Refactored plugin system for improved readability and maintainability',
      'Cleaned up code formatting across core, plugins, and provider packages',
      'Updated package versions and dependencies for all packages',
      'Expanded test coverage for partial upload and resume context scenarios',
    ],
  },
  {
    version: 'v1.0.1',
    date: 'Feb 15, 2026',
    title: 'Documentation & Messaging Update',
    improvements: [
      'Updated descriptions, READMEs, and documentation to reflect the new "One API" messaging strategy',
    ],
  },
  {
    version: 'v0.1.1',
    date: 'Feb 3, 2026',
    title: 'Package Optimizations',
    improvements: [
      'Externalized vitest from testing module to reduce package size',
      'Disabled source maps and removed tsdown dependency',
      'Added typed analytics events',
      'Updated repository URL',
    ],
  },
  {
    version: 'v0.1.0',
    date: 'Jan 28, 2026',
    title: 'Initial Release',
    features: [
      'Unified API for Cloudinary, S3, and R2',
      'TypeScript-first architecture with full type safety',
      'Plugin system with file validation, image optimization, metadata extraction, analytics, and retry',
      'Magic-byte based file type detection in core',
    ],
  },
];

function EntrySection({ label, items, color }: { label: string; items: string[]; color: string }) {
  return (
    <div className="mt-4">
      <h3 className={`text-sm font-semibold mb-2 ${color}`}>{label}</h3>
      <ul className="list-disc list-inside text-muted-foreground space-y-1 text-sm">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export default function ChangelogPage() {
  return (
    <div className="container py-20 max-w-2xl mx-auto px-4">
      <div className="text-center mb-12">
        <div className="mb-5 p-4 rounded-lg bg-brand-muted text-brand inline-flex w-16 h-16 items-center justify-center mx-auto">
          <Clock className="h-8 w-8" />
        </div>
        <h1 className="text-4xl font-bold mb-4">Changelog</h1>
        <p className="text-muted-foreground text-lg">
          Track the latest updates and improvements to FluxMedia.
        </p>
      </div>

      <div className="space-y-8">
        {changelog.map((entry) => (
          <div
            key={entry.version}
            className="group rounded-xl border border-border bg-card p-6 text-left transition-all hover:border-brand/30"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="bg-brand-muted text-brand px-3 py-1 rounded-md text-xs font-semibold">
                {entry.version}
              </div>
              <span className="text-sm text-muted-foreground">{entry.date}</span>
            </div>
            <h2 className="text-xl font-semibold mb-1">{entry.title}</h2>

            {entry.features && entry.features.length > 0 && (
              <EntrySection label="Features" items={entry.features} color="text-emerald-500" />
            )}
            {entry.fixes && entry.fixes.length > 0 && (
              <EntrySection label="Bug Fixes" items={entry.fixes} color="text-red-400" />
            )}
            {entry.improvements && entry.improvements.length > 0 && (
              <EntrySection label="Improvements" items={entry.improvements} color="text-blue-400" />
            )}
          </div>
        ))}
      </div>

      <div className="text-center mt-10">
        <Button variant="outline" asChild>
          <Link href="/">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back Home
          </Link>
        </Button>
      </div>
    </div>
  );
}
