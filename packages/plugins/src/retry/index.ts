/**
 * Retry Plugin for FluxMedia
 *
 * Retries failed uploads with exponential backoff and jitter.
 */

import {
  type FluxMediaPlugin,
  type UploadOptions,
  type PartialUploadContext,
  MediaError,
  MediaErrorCode,
  PartialUploadError,
  isAbortError,
  isStreamInput,
} from '@fluxmedia/core';

/**
 * Options for the retry plugin
 */
export interface RetryOptions {
  /** Maximum number of retries (default: 3) */
  maxRetries?: number;
  /** Base delay in milliseconds (default: 1000) */
  retryDelay?: number;
  /** Upper bound for a single delay in milliseconds (default: 30000) */
  maxDelay?: number;
  /** Use exponential backoff (default: true) */
  exponentialBackoff?: boolean;
  /** Randomize delays by ±50% to avoid thundering herds (default: true) */
  jitter?: boolean;
  /** Error codes that should trigger a retry */
  retryableErrors?: MediaErrorCode[];
  /** Callback when a retry is attempted */
  onRetry?: ((attempt: number, error: Error, nextDelay: number) => void) | undefined;
  /** Custom function to determine if error should be retried */
  shouldRetry?: ((error: Error, attempt: number) => boolean) | undefined;
}

/**
 * @deprecated The retry plugin no longer stores configuration in metadata.
 */
export interface RetryMetadata {
  maxRetries: number;
  currentAttempt: number;
  config: RetryOptions;
}

/**
 * Default retryable error codes
 */
const DEFAULT_RETRYABLE_ERRORS: MediaErrorCode[] = [
  MediaErrorCode.NETWORK_ERROR,
  MediaErrorCode.RATE_LIMITED,
  MediaErrorCode.PROVIDER_ERROR,
  MediaErrorCode.UPLOAD_FAILED,
];

/**
 * Sleep for a given number of milliseconds, waking early on abort.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new MediaError('Operation aborted', MediaErrorCode.ABORTED, 'retry-plugin'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MediaError('Operation aborted', MediaErrorCode.ABORTED, 'retry-plugin'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Check if an error is retryable
 */
function isRetryableError(error: Error, retryableErrors: MediaErrorCode[]): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof MediaError) {
    return retryableErrors.includes(error.code);
  }

  // Check for common network errors by message
  const message = error.message.toLowerCase();
  return (
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('rate limit') ||
    message.includes('socket hang up')
  );
}

function resolveConfig(options: RetryOptions) {
  return {
    maxRetries: options.maxRetries ?? 3,
    retryDelay: options.retryDelay ?? 1000,
    maxDelay: options.maxDelay ?? 30_000,
    exponentialBackoff: options.exponentialBackoff ?? true,
    jitter: options.jitter ?? true,
    retryableErrors: options.retryableErrors ?? DEFAULT_RETRYABLE_ERRORS,
    onRetry: options.onRetry,
    shouldRetry: options.shouldRetry,
  };
}

function computeDelay(config: ReturnType<typeof resolveConfig>, attempt: number): number {
  const base = config.exponentialBackoff
    ? config.retryDelay * Math.pow(2, attempt)
    : config.retryDelay;
  const capped = Math.min(base, config.maxDelay);
  return config.jitter ? Math.round(capped * (0.5 + Math.random())) : capped;
}

/**
 * Create a retry plugin. It wraps the provider upload and retries it on
 * retryable errors (network, rate limiting, provider 5xx by default).
 *
 * Streams are uploaded once and never retried: a stream that has been read
 * cannot be read again. Aborted uploads are never retried.
 *
 * @example
 * ```typescript
 * await uploader.use(createRetryPlugin({
 *   maxRetries: 3,
 *   onRetry: (attempt, error, delay) => {
 *     console.log(`Retry ${attempt} after ${delay}ms: ${error.message}`);
 *   },
 * }));
 * ```
 */
export function createRetryPlugin(options: RetryOptions = {}): FluxMediaPlugin {
  return {
    name: 'retry',
    version: '2.0.0',
    hooks: {
      wrapUpload: (next) => async (file, uploadOptions: UploadOptions) => {
        if (isStreamInput(file)) return next(file, uploadOptions);
        return withRetry(() => next(file, uploadOptions), {
          ...options,
          ...(uploadOptions.signal && { signal: uploadOptions.signal }),
        });
      },
    },
  };
}

/**
 * Wrap an async function with retry logic.
 *
 * When the function throws a `PartialUploadError`, its upload context is
 * passed to the next attempt as `resumeContext`, for custom upload code that
 * can resume multipart uploads.
 *
 * @example
 * ```typescript
 * const result = await withRetry(() => uploader.upload(buffer, opts), {
 *   maxRetries: 3,
 *   onRetry: (attempt, error, delay) => console.log(`Retry ${attempt} after ${delay}ms`),
 * });
 * ```
 */
export async function withRetry<T>(
  fn: (resumeContext?: PartialUploadContext) => Promise<T>,
  options: RetryOptions & { signal?: AbortSignal } = {}
): Promise<T> {
  const config = resolveConfig(options);

  let lastError: Error = new Error('Unknown error');
  let resumeContext: PartialUploadContext | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn(resumeContext);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Capture resume context from partial uploads
      if (error instanceof PartialUploadError) {
        resumeContext = error.uploadContext;
      }

      const shouldRetry =
        !isAbortError(lastError) &&
        !options.signal?.aborted &&
        (config.shouldRetry
          ? config.shouldRetry(lastError, attempt)
          : isRetryableError(lastError, config.retryableErrors));

      // Don't retry if this was the last attempt or error is not retryable
      if (attempt === config.maxRetries || !shouldRetry) {
        throw lastError;
      }

      const delay = computeDelay(config, attempt);
      config.onRetry?.(attempt + 1, lastError, delay);
      await sleep(delay, options.signal);
    }
  }

  throw lastError;
}

/**
 * @deprecated The retry plugin no longer stores configuration in upload
 * metadata; this always returns the value of `options.metadata._retry`
 * (undefined unless you set it yourself).
 */
export function getRetryConfig(options: UploadOptions): RetryMetadata | undefined {
  return options.metadata?._retry as RetryMetadata | undefined;
}
