/**
 * Deduplication Plugin for FluxMedia
 *
 * Skips the upload when identical content was already uploaded to the same
 * scope, returning the existing result instead.
 */

import type { FluxMediaPlugin, UploadOptions, UploadResult } from '@fluxmedia/core';
import { sanitizeFolder, sanitizeKeySegment } from '@fluxmedia/core';
import { createHash } from 'node:crypto';
import { fileToBuffer, isInspectable } from '../utils';

/**
 * Where content hashes are remembered. Back it with your database or cache
 * in production; the in-memory store only lasts for the process lifetime.
 */
export interface DedupeStore {
  get(key: string): Promise<UploadResult | undefined> | UploadResult | undefined;
  set(key: string, result: UploadResult): Promise<void> | void;
  /** Forget entries pointing at a deleted file (called from afterDelete). */
  deleteById?(id: string): Promise<void> | void;
}

export interface DedupeOptions {
  /** Hash store (default: in-memory). */
  store?: DedupeStore;
  /** Hash algorithm (default sha256). */
  algorithm?: 'sha256' | 'sha1' | 'md5';
  /**
   * Scope deduplication so content is only shared within it. Defaults to
   * the upload folder (plus the filename when `uniqueFilename` is false), so
   * one user's upload is never returned for another user's folder. Return a
   * constant to deduplicate globally.
   */
  scope?: (options: UploadOptions) => string;
  /**
   * Check that a remembered file still exists before reusing it.
   * Recommended when files can be deleted outside this uploader.
   */
  verify?: (result: UploadResult) => Promise<boolean>;
}

/**
 * Simple in-memory store with optional size limit (LRU eviction).
 */
export function createMemoryDedupeStore(maxEntries = 10_000): DedupeStore {
  const map = new Map<string, UploadResult>();
  return {
    get(key) {
      const value = map.get(key);
      if (value) {
        map.delete(key);
        map.set(key, value);
      }
      return value;
    },
    set(key, result) {
      map.set(key, result);
      if (map.size > maxEntries) map.delete(map.keys().next().value!);
    },
    deleteById(id) {
      for (const [key, value] of map) if (value.id === id || value.storageKey === id) map.delete(key);
    },
  };
}

/**
 * Default scope: the folder, plus the filename when the caller asked for an
 * exact key (`uniqueFilename: false`) — returning a file stored under another
 * name would not be what they requested.
 */
function defaultScope(options: UploadOptions): string {
  const folder = sanitizeFolder(options.folder);
  return options.uniqueFilename === false && options.filename
    ? `${folder}\u0000${sanitizeKeySegment(options.filename)}`
    : folder;
}

/**
 * Create a deduplication plugin. Streams are always uploaded (they cannot be
 * hashed without consuming them).
 *
 * Results returned for duplicates have `metadata.deduplicated: true`.
 */
export function createDeduplicationPlugin(options: DedupeOptions = {}): FluxMediaPlugin {
  const store = options.store ?? createMemoryDedupeStore();
  const algorithm = options.algorithm ?? 'sha256';
  const scope = options.scope ?? defaultScope;

  return {
    name: 'dedupe',
    version: '1.0.0',
    hooks: {
      wrapUpload: (next) => async (file, uploadOptions) => {
        if (!isInspectable(file)) return next(file, uploadOptions);
        const hash = createHash(algorithm).update(await fileToBuffer(file)).digest('hex');
        const key = `${scope(uploadOptions)}\u0000${algorithm}:${hash}`;

        const existing = await store.get(key);
        if (existing && (!options.verify || (await options.verify(existing)))) {
          return { ...existing, metadata: { ...existing.metadata, deduplicated: true, contentHash: hash } };
        }

        const result = await next(file, uploadOptions);
        await store.set(key, result);
        return { ...result, metadata: { ...result.metadata, contentHash: hash } };
      },
      async afterDelete(id: string) {
        await store.deleteById?.(id);
      },
    },
  };
}
