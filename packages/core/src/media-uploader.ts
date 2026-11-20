import type {
  MediaProvider,
  UploadOptions,
  UploadResult,
  UploadInput,
  TransformationOptions,
  SearchOptions,
  ResourceOptions,
  SignedUrlOptions,
  SignedUploadOptions,
  SignedUploadTarget,
  ListOptions,
  ListResult,
  DownloadResult,
} from './types';
import { MediaErrorCode, MediaError, isAbortError } from './errors';
import { PluginManager, type FluxMediaPlugin, type UploadPhase } from './plugin';
import { isStreamInput, mapSettled, throwIfAborted } from './utils';

/**
 * Configuration for MediaUploader with optional fallback provider.
 */
export interface MediaUploaderConfig {
  /**
   * Provider to use if the primary provider fails with a retryable error.
   * Stream inputs are never sent to the fallback (a stream can be read once).
   */
  fallbackProvider?: MediaProvider;

  /**
   * Error codes that trigger failover to the fallback provider.
   * Defaults to NETWORK_ERROR and PROVIDER_ERROR.
   */
  fallbackOnErrors?: MediaErrorCode[];

  /**
   * Called when failover occurs. Useful for alerting / observability.
   */
  onFallback?: (error: Error, fromProvider: string, toProvider: string) => void;
}

/**
 * A reference to a stored file: its ID / storage key, or the `UploadResult`
 * returned by `upload()`. Passing the result lets `MediaUploader` route the
 * call to the provider that stored the file (after a failover) and pass
 * provider hints (e.g. Cloudinary resource type).
 */
export type FileRef = string | UploadResult;

/**
 * Options for batch uploads.
 */
export interface UploadMultipleOptions extends UploadOptions {
  /** How many uploads run at once (default 3). */
  concurrency?: number;
  /** Called after each file finishes (successfully or not). */
  onBatchProgress?: (completed: number, total: number) => void;
}

type OptionalMethod =
  | 'getSignedUrl'
  | 'createUploadUrl'
  | 'exists'
  | 'list'
  | 'search'
  | 'copy'
  | 'move'
  | 'download'
  | 'updateMetadata';

/**
 * Main entry point for FluxMedia.
 * Provides a unified API for uploading to any supported provider.
 *
 * @example
 * ```typescript
 * import { MediaUploader } from '@fluxmedia/core';
 * import { CloudinaryProvider } from '@fluxmedia/cloudinary';
 *
 * const uploader = new MediaUploader(
 *   new CloudinaryProvider({
 *     cloudName: 'your-cloud',
 *     apiKey: 'your-key',
 *     apiSecret: 'your-secret'
 *   })
 * );
 *
 * await uploader.use({
 *   name: 'logger',
 *   hooks: {
 *     beforeUpload: async (file, options) => {
 *       console.log('Uploading:', options.filename);
 *       return { file, options };
 *     }
 *   }
 * });
 *
 * const result = await uploader.upload(file, {
 *   folder: 'avatars',
 *   transformation: { width: 400, format: 'webp' }
 * });
 * ```
 */
export class MediaUploader {
  /**
   * The underlying provider instance
   */
  public readonly provider: MediaProvider;

  /**
   * Plugin manager with caching and override support
   */
  public readonly plugins: PluginManager;

  /**
   * Optional configuration with fallback provider support.
   */
  private readonly config: MediaUploaderConfig;

  /**
   * Registration of constructor plugins (their `init()` may be async).
   */
  private readonly pending: Promise<void>;

  /**
   * Default error codes that trigger fallback.
   */
  private static readonly DEFAULT_FALLBACK_ERRORS: MediaErrorCode[] = [
    MediaErrorCode.NETWORK_ERROR,
    MediaErrorCode.PROVIDER_ERROR,
  ];

  /**
   * Create a new MediaUploader instance.
   *
   * @param provider - Provider implementation (e.g., CloudinaryProvider, S3Provider)
   * @param plugins - Optional plugins to register. Their `init()` is awaited
   *   before the first operation; a failing `init()` makes every operation
   *   reject with that error (await `ready()` to surface it early).
   * @param config - Optional configuration with fallback provider support
   */
  constructor(provider: MediaProvider, plugins?: FluxMediaPlugin[], config?: MediaUploaderConfig) {
    this.provider = provider;
    this.plugins = new PluginManager();
    this.config = config ?? {};
    this.pending = plugins?.length
      ? this.plugins.registerAll(plugins).then(() => undefined)
      : Promise.resolve();
    // Prevent an unhandled rejection; the error surfaces on the next operation.
    this.pending.catch(() => undefined);
  }

  /**
   * Resolves once constructor plugins are initialized; rejects if one failed.
   */
  ready(): Promise<void> {
    return this.pending;
  }

  /**
   * Register a plugin.
   * If a plugin with the same name exists, it will be overridden (last takes precedence).
   *
   * @example
   * ```typescript
   * await uploader.use(loggerPlugin);
   * await uploader.use(validationPlugin);
   * ```
   */
  async use(plugin: FluxMediaPlugin): Promise<this> {
    await this.pending;
    await this.plugins.register(plugin);
    return this;
  }

  /**
   * Upload a file.
   *
   * Runs `beforeUpload` hooks, then the provider upload wrapped by any
   * `wrapUpload` hooks (retry, dedupe, …) with failover to the fallback
   * provider, then `afterUpload` hooks. Failures in any phase are reported to
   * `onError` hooks with the phase.
   */
  async upload(file: UploadInput, options?: UploadOptions): Promise<UploadResult> {
    await this.pending;
    const initialOptions = options ?? {};
    throwIfAborted(initialOptions.signal, this.provider.name);

    let processedFile = file;
    let processedOptions = initialOptions;
    try {
      ({ file: processedFile, options: processedOptions } = await this.plugins.runBeforeUpload(
        file,
        initialOptions
      ));
    } catch (error) {
      await this.reportError(error, file, initialOptions, 'beforeUpload');
      throw error;
    }

    let result: UploadResult;
    try {
      const doUpload = this.plugins.composeUpload((f, o) => this.uploadWithFallback(f, o));
      result = await doUpload(processedFile, processedOptions);
    } catch (error) {
      await this.reportError(error, processedFile, processedOptions, 'upload');
      throw error;
    }

    try {
      return await this.plugins.runAfterUpload(result, {
        file: processedFile,
        options: processedOptions,
      });
    } catch (error) {
      // A post-upload hook failed — the uploaded object exists and may need cleanup
      await this.reportError(error, processedFile, processedOptions, 'afterUpload', result);
      throw error;
    }
  }

  /**
   * Delete a file. Runs beforeDelete and afterDelete plugin hooks.
   */
  async delete(ref: FileRef, options?: ResourceOptions): Promise<void> {
    await this.pending;
    const { provider, id, hints } = this.resolve(ref, options);
    const processedId = await this.plugins.runBeforeDelete(id);
    await (hints ? provider.delete(processedId, hints) : provider.delete(processedId));
    await this.plugins.runAfterDelete(processedId);
  }

  /**
   * Get metadata for a file.
   * @throws {MediaError} FILE_NOT_FOUND if the file does not exist
   */
  async get(ref: FileRef, options?: ResourceOptions): Promise<UploadResult> {
    await this.pending;
    const { provider, id, hints } = this.resolve(ref, options);
    return hints ? provider.get(id, hints) : provider.get(id);
  }

  /**
   * Generate a URL for a file, optionally with transformations.
   * Synchronous, so `beforeGetUrl` hooks do not run — use `getUrlAsync`.
   * For private storage, use `getSignedUrl`.
   */
  getUrl(ref: FileRef, transform?: TransformationOptions): string {
    const { provider, id, hints } = this.resolve(ref);
    return hints ? provider.getUrl(id, transform, hints) : provider.getUrl(id, transform);
  }

  /**
   * Generate a URL with async plugin hook support.
   */
  async getUrlAsync(ref: FileRef, transform?: TransformationOptions): Promise<string> {
    await this.pending;
    const { provider, id, hints } = this.resolve(ref);
    const { id: processedId, transform: processedTransform } = await this.plugins.runBeforeGetUrl(
      id,
      transform
    );
    return hints
      ? provider.getUrl(processedId, processedTransform, hints)
      : provider.getUrl(processedId, processedTransform);
  }

  /**
   * Create a time-limited URL for reading a (private) file.
   *
   * @example
   * ```typescript
   * const url = await uploader.getSignedUrl(result, { expiresIn: 300 });
   * ```
   */
  async getSignedUrl(ref: FileRef, options?: SignedUrlOptions): Promise<string> {
    await this.pending;
    const { provider, id, hints } = this.resolve(ref, options);
    const fn = this.require(provider, 'getSignedUrl');
    return fn.call(provider, id, { ...options, ...hints });
  }

  /**
   * Create a signed target a browser can upload to directly. Decide `folder`
   * and limits on the server; never pass client input through unchecked —
   * see `createSignedUploadHandler` in `@fluxmedia/core/server`.
   */
  async createUploadUrl(options: SignedUploadOptions): Promise<SignedUploadTarget> {
    await this.pending;
    return this.require(this.provider, 'createUploadUrl').call(this.provider, options);
  }

  /**
   * Check whether a file exists.
   */
  async exists(ref: FileRef, options?: ResourceOptions): Promise<boolean> {
    await this.pending;
    const { provider, id, hints } = this.resolve(ref, options);
    const fn = provider.exists;
    if (fn) return hints ? fn.call(provider, id, hints) : fn.call(provider, id);
    try {
      await (hints ? provider.get(id, hints) : provider.get(id));
      return true;
    } catch (error) {
      if (error instanceof MediaError && error.code === MediaErrorCode.FILE_NOT_FOUND) return false;
      throw error;
    }
  }

  /**
   * List stored files page by page (primary provider).
   */
  async list(options?: ListOptions): Promise<ListResult> {
    await this.pending;
    return this.require(this.provider, 'list').call(this.provider, options);
  }

  /**
   * Iterate over every stored file under a folder, following cursors.
   */
  async *listAll(options?: Omit<ListOptions, 'cursor'>): AsyncGenerator<UploadResult> {
    let cursor: string | undefined;
    do {
      const page = await this.list(cursor ? { ...options, cursor } : options);
      yield* page.items;
      cursor = page.nextCursor;
    } while (cursor);
  }

  /**
   * Search for files (primary provider).
   */
  async search(query: SearchOptions): Promise<UploadResult[]> {
    await this.pending;
    return this.require(this.provider, 'search').call(this.provider, query);
  }

  /**
   * Copy a file to a new storage key.
   */
  async copy(ref: FileRef, toId: string, options?: ResourceOptions): Promise<UploadResult> {
    await this.pending;
    const { provider, id, hints } = this.resolve(ref, options);
    return this.require(provider, 'copy').call(provider, id, toId, hints);
  }

  /**
   * Move/rename a file.
   */
  async move(ref: FileRef, toId: string, options?: ResourceOptions): Promise<UploadResult> {
    await this.pending;
    const { provider, id, hints } = this.resolve(ref, options);
    return this.require(provider, 'move').call(provider, id, toId, hints);
  }

  /**
   * Stream a file's contents.
   */
  async download(ref: FileRef, options?: ResourceOptions): Promise<DownloadResult> {
    await this.pending;
    const { provider, id, hints } = this.resolve(ref, options);
    return this.require(provider, 'download').call(provider, id, hints);
  }

  /**
   * Replace a file's custom metadata.
   */
  async updateMetadata(
    ref: FileRef,
    metadata: Record<string, unknown>,
    options?: ResourceOptions
  ): Promise<void> {
    await this.pending;
    const { provider, id, hints } = this.resolve(ref, options);
    return this.require(provider, 'updateMetadata').call(provider, id, metadata, hints);
  }

  /**
   * Upload multiple files, running plugins for each.
   *
   * @throws {MediaError} UPLOAD_FAILED when any upload fails; `details.succeeded`
   *   holds the results that did upload and `details.failed` the errors by index.
   */
  async uploadMultiple(
    files: UploadInput[],
    options?: UploadMultipleOptions
  ): Promise<UploadResult[]> {
    const { concurrency = 3, onBatchProgress, ...uploadOptions } = options ?? {};
    const hasOptions = options !== undefined;
    let completed = 0;
    const settled = await mapSettled(files, concurrency, async (file) => {
      try {
        return await this.upload(file, hasOptions ? uploadOptions : undefined);
      } finally {
        onBatchProgress?.(++completed, files.length);
      }
    });
    return this.collect(settled, MediaErrorCode.UPLOAD_FAILED, 'upload');
  }

  /**
   * Delete multiple files. Plain IDs are deleted with the provider's batch
   * API; `UploadResult`s are routed to their provider with hints.
   *
   * @throws {MediaError} DELETE_FAILED listing the IDs that failed
   */
  async deleteMultiple(refs: FileRef[], options?: { concurrency?: number }): Promise<void> {
    await this.pending;
    const concurrency = options?.concurrency ?? 5;
    const failed: Array<{ id: string; error: unknown }> = [];

    // Group plain IDs per provider for batch deletion
    const batches = new Map<MediaProvider, string[]>();
    const individual: FileRef[] = [];
    for (const ref of refs) {
      const { provider, id, hints } = this.resolve(ref);
      if (hints) {
        individual.push(ref);
      } else {
        batches.set(provider, [...(batches.get(provider) ?? []), id]);
      }
    }

    for (const [provider, ids] of batches) {
      const processed: string[] = [];
      for (const id of ids) {
        try {
          processed.push(await this.plugins.runBeforeDelete(id));
        } catch (error) {
          failed.push({ id, error });
        }
      }
      if (processed.length === 0) continue;
      try {
        await provider.deleteMultiple(processed);
        for (const id of processed) await this.plugins.runAfterDelete(id);
      } catch (error) {
        const failedIds = new Set(
          (error instanceof MediaError && Array.isArray(error.details?.failedIds)
            ? (error.details.failedIds as string[])
            : processed)
        );
        for (const id of processed) {
          if (failedIds.has(id)) failed.push({ id, error });
          else await this.plugins.runAfterDelete(id);
        }
      }
    }

    const settled = await mapSettled(individual, concurrency, (ref) => this.delete(ref));
    settled.forEach((result, index) => {
      if (result.status === 'rejected') {
        failed.push({ id: this.resolve(individual[index]!).id, error: result.reason });
      }
    });

    if (failed.length > 0) {
      throw new MediaError(
        `Failed to delete ${failed.length} of ${refs.length} files: ${failed.map((f) => f.id).join(', ')}`,
        MediaErrorCode.DELETE_FAILED,
        this.provider.name,
        failed[0]!.error,
        { failedIds: failed.map((f) => f.id), failed }
      );
    }
  }

  /**
   * Check if the provider supports a specific feature.
   *
   * @param feature - Feature path (e.g., 'transformations.resize', 'capabilities.signedUrls')
   */
  supports(feature: string): boolean {
    const parts = feature.split('.');
    let current: unknown = this.provider.features;

    for (const part of parts) {
      if (typeof current === 'object' && current !== null && part in current) {
        current = (current as Record<string, unknown>)[part];
      } else {
        return false;
      }
    }

    return current === true;
  }

  /**
   * Upload a file with transactional semantics.
   *
   * Performs the upload, then calls `onCommit`. If `onCommit` throws
   * (e.g. a database insert fails), the uploaded file is rolled back by
   * calling `onRollback` or, if none is provided, by deleting it from the
   * provider that stored it.
   *
   * @example
   * ```typescript
   * const { uploadResult } = await uploader.uploadWithTransaction(
   *   videoBuffer,
   *   { folder: 'videos', filename: 'intro' },
   *   {
   *     onCommit: async (result) => {
   *       await db.files.insert({ storageKey: result.storageKey, url: result.url });
   *     },
   *   }
   * );
   * ```
   */
  async uploadWithTransaction<T = void>(
    file: UploadInput,
    options: UploadOptions,
    { onCommit, onRollback }: TransactionCallbacks<T>
  ): Promise<{ uploadResult: UploadResult; commitResult: T }> {
    const uploadResult = await this.upload(file, options);

    try {
      const commitResult = await onCommit(uploadResult);
      return { uploadResult, commitResult };
    } catch (commitError) {
      const err = commitError instanceof Error ? commitError : new Error(String(commitError));

      if (onRollback) {
        try {
          await onRollback(uploadResult, err);
        } catch (rollbackError) {
          console.error('[FluxMedia] Rollback failed:', rollbackError);
        }
      } else if (uploadResult.storageKey) {
        // Default rollback: delete the uploaded file from the provider that stored it
        try {
          await this.delete(uploadResult);
        } catch (deleteError) {
          console.error('[FluxMedia] Default rollback (delete) failed:', deleteError);
        }
      }

      throw err;
    }
  }

  /**
   * Upload to the primary provider, failing over to the fallback when
   * configured and the error qualifies.
   */
  private async uploadWithFallback(file: UploadInput, options: UploadOptions): Promise<UploadResult> {
    try {
      return await this.provider.upload(file, options);
    } catch (primaryError) {
      const fallback = this.config.fallbackProvider;
      if (!fallback || isStreamInput(file) || !this.shouldFallback(primaryError)) {
        throw primaryError;
      }
      this.config.onFallback?.(
        primaryError instanceof Error ? primaryError : new Error(String(primaryError)),
        this.provider.name,
        fallback.name
      );
      return fallback.upload(file, options);
    }
  }

  /**
   * Resolve a file reference to the provider that holds it, its ID and hints.
   */
  private resolve(
    ref: FileRef,
    options?: ResourceOptions
  ): { provider: MediaProvider; id: string; hints: ResourceOptions | undefined } {
    if (typeof ref === 'string') {
      return { provider: this.provider, id: ref, hints: options?.metadata ? options : undefined };
    }
    const fallback = this.config.fallbackProvider;
    const provider =
      ref.provider !== this.provider.name && fallback && ref.provider === fallback.name
        ? fallback
        : this.provider;
    return {
      provider,
      id: ref.storageKey ?? ref.id,
      hints: { metadata: { ...ref.metadata, ...options?.metadata } },
    };
  }

  /**
   * Return a provider's optional method or throw NOT_SUPPORTED.
   */
  private require<K extends OptionalMethod>(
    provider: MediaProvider,
    method: K
  ): NonNullable<MediaProvider[K]> {
    const fn = provider[method];
    if (typeof fn !== 'function') {
      throw new MediaError(
        `${method} is not supported by the ${provider.name} provider`,
        MediaErrorCode.NOT_SUPPORTED,
        provider.name
      );
    }
    return fn as NonNullable<MediaProvider[K]>;
  }

  private collect<T>(
    settled: PromiseSettledResult<T>[],
    code: MediaErrorCode,
    verb: string
  ): T[] {
    const failed = settled
      .map((r, index) => ({ r, index }))
      .filter((x): x is { r: PromiseRejectedResult; index: number } => x.r.status === 'rejected')
      .map(({ r, index }) => ({ index, error: r.reason as unknown }));
    const succeeded = settled
      .filter((r): r is PromiseFulfilledResult<Awaited<T>> => r.status === 'fulfilled')
      .map((r) => r.value);
    if (failed.length === 0) return succeeded;
    const first = failed[0]!.error;
    throw new MediaError(
      `${failed.length} of ${settled.length} ${verb}s failed: ${first instanceof Error ? first.message : String(first)}`,
      first instanceof MediaError ? first.code : code,
      this.provider.name,
      first,
      { succeeded, failed }
    );
  }

  /**
   * Run onError hooks without letting a failing hook mask the original error.
   */
  private async reportError(
    error: unknown,
    file: UploadInput,
    options: UploadOptions,
    phase: UploadPhase,
    uploadResult?: UploadResult
  ): Promise<void> {
    const err = error instanceof Error ? error : new Error(String(error));
    try {
      await this.plugins.runOnError(
        err,
        uploadResult ? { file, options, phase, uploadResult } : { file, options, phase }
      );
    } catch (hookError) {
      console.warn('[FluxMedia] onError hook failed:', hookError);
    }
  }

  /**
   * Determine whether a failed upload should fall back to the fallback provider.
   */
  private shouldFallback(error: unknown): boolean {
    if (isAbortError(error)) return false;
    const fallbackCodes = this.config.fallbackOnErrors ?? MediaUploader.DEFAULT_FALLBACK_ERRORS;

    if (error instanceof MediaError) {
      return fallbackCodes.includes(error.code);
    }

    // Heuristic: common network-level error messages
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      return (
        msg.includes('network') ||
        msg.includes('timeout') ||
        msg.includes('econnrefused') ||
        msg.includes('econnreset') ||
        msg.includes('socket hang up')
      );
    }

    return false;
  }
}

/**
 * Callbacks for `uploadWithTransaction()`.
 */
export interface TransactionCallbacks<T> {
  /** Called after upload succeeds. Throw to trigger rollback. */
  onCommit: (result: UploadResult) => Promise<T>;
  /** Called if onCommit throws. Receives the upload result for cleanup. */
  onRollback?: (result: UploadResult, error: Error) => Promise<void>;
}
