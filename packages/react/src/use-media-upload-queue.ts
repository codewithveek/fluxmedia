import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClientUploadOptions,
  UploadQueueItem,
  UseMediaUploadConfig,
  UseMediaUploadQueueOptions,
  UseMediaUploadQueueReturn,
} from './types';
import { UploadClientError, uploadFile, validateFile } from './upload-client';

let counter = 0;
const nextId = () => `upload-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/**
 * Upload many files with per-file progress, cancel and retry.
 *
 * @example
 * ```tsx
 * const queue = useMediaUploadQueue({ mode: 'signed', signUrlEndpoint: '/api/upload/sign' });
 * <input type="file" multiple onChange={(e) => queue.add(e.target.files!)} />
 * {queue.items.map((item) => (
 *   <div key={item.id}>
 *     {item.file.name} {item.status} {item.progress}%
 *     {item.status === 'uploading' && <button onClick={() => queue.cancel(item.id)}>Cancel</button>}
 *     {item.status === 'error' && <button onClick={() => queue.retry(item.id)}>Retry</button>}
 *   </div>
 * ))}
 * ```
 */
export function useMediaUploadQueue(
  config: UseMediaUploadConfig,
  queueOptions: UseMediaUploadQueueOptions = {}
): UseMediaUploadQueueReturn {
  const concurrency = Math.max(1, queueOptions.concurrency ?? 3);
  const autoStart = queueOptions.autoStart ?? true;

  const [items, setItems] = useState<UploadQueueItem[]>([]);
  const itemsRef = useRef<UploadQueueItem[]>([]);
  const configRef = useRef(config);
  configRef.current = config;
  const optionsRef = useRef(queueOptions);
  optionsRef.current = queueOptions;

  const controllers = useRef(new Map<string, AbortController>());
  const uploadOptions = useRef(new Map<string, ClientUploadOptions>());
  const mountedRef = useRef(true);
  const startedRef = useRef(autoStart);
  const hadActiveRef = useRef(false);

  const commit = useCallback((updater: (prev: UploadQueueItem[]) => UploadQueueItem[]) => {
    itemsRef.current = updater(itemsRef.current);
    if (mountedRef.current) setItems(itemsRef.current);
  }, []);

  const update = useCallback(
    (id: string, patch: Partial<UploadQueueItem>) =>
      commit((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item))),
    [commit]
  );

  const pump = useCallback(() => {
    if (!startedRef.current) return;
    const active = itemsRef.current.filter((i) => i.status === 'uploading').length;
    const pending = itemsRef.current.filter((i) => i.status === 'pending').slice(0, concurrency - active);

    for (const item of pending) {
      const controller = new AbortController();
      controllers.current.set(item.id, controller);
      hadActiveRef.current = true;
      update(item.id, { status: 'uploading', progress: 0, error: null });

      uploadFile(
        item.file,
        configRef.current,
        { ...uploadOptions.current.get(item.id), signal: controller.signal },
        (progress) => update(item.id, { progress })
      )
        .then((result) => {
          update(item.id, { status: 'done', progress: 100, result });
          configRef.current.onUploadComplete?.(result);
        })
        .catch((error: unknown) => {
          const err = error instanceof Error ? error : new UploadClientError('Upload failed', 'network');
          const cancelled = err instanceof UploadClientError && err.kind === 'aborted';
          update(item.id, { status: cancelled ? 'cancelled' : 'error', error: cancelled ? null : err });
          if (!cancelled) configRef.current.onUploadError?.(err);
        })
        .finally(() => {
          controllers.current.delete(item.id);
          pump();
        });
    }

    const stillActive = itemsRef.current.some((i) => i.status === 'uploading' || i.status === 'pending');
    if (!stillActive && hadActiveRef.current) {
      hadActiveRef.current = false;
      optionsRef.current.onQueueComplete?.(itemsRef.current);
    }
  }, [concurrency, update]);

  useEffect(() => {
    mountedRef.current = true;
    const map = controllers.current;
    return () => {
      mountedRef.current = false;
      map.forEach((c) => c.abort());
    };
  }, []);

  const add = useCallback(
    (files: File[] | FileList, options?: ClientUploadOptions) => {
      const list = Array.from(files);
      const newItems = list.map<UploadQueueItem>((file) => {
        const id = nextId();
        if (options) uploadOptions.current.set(id, options);
        const invalid = validateFile(file, {
          accept: configRef.current.accept,
          maxSize: configRef.current.maxSize,
        });
        return {
          id,
          file,
          status: invalid ? 'error' : 'pending',
          progress: 0,
          result: null,
          error: invalid ? new UploadClientError(invalid, 'validation') : null,
        };
      });
      commit((prev) => [...prev, ...newItems]);
      pump();
    },
    [commit, pump]
  );

  const start = useCallback(() => {
    startedRef.current = true;
    pump();
  }, [pump]);

  const cancel = useCallback(
    (id: string) => {
      const controller = controllers.current.get(id);
      if (controller) controller.abort();
      else if (itemsRef.current.find((i) => i.id === id)?.status === 'pending') {
        update(id, { status: 'cancelled' });
      }
    },
    [update]
  );

  const cancelAll = useCallback(() => {
    itemsRef.current.forEach((item) => cancel(item.id));
  }, [cancel]);

  const retry = useCallback(
    (id: string) => {
      const item = itemsRef.current.find((i) => i.id === id);
      if (!item || (item.status !== 'error' && item.status !== 'cancelled')) return;
      const invalid = validateFile(item.file, {
        accept: configRef.current.accept,
        maxSize: configRef.current.maxSize,
      });
      if (invalid) return;
      update(id, { status: 'pending', progress: 0, error: null });
      pump();
    },
    [pump, update]
  );

  const remove = useCallback(
    (id: string) => {
      controllers.current.get(id)?.abort();
      uploadOptions.current.delete(id);
      commit((prev) => prev.filter((i) => i.id !== id));
    },
    [commit]
  );

  const clear = useCallback(() => {
    controllers.current.forEach((c) => c.abort());
    uploadOptions.current.clear();
    commit(() => []);
  }, [commit]);

  const { uploading, progress } = useMemo(() => {
    const counted = items.filter((i) => i.status !== 'cancelled');
    return {
      uploading: items.some((i) => i.status === 'uploading'),
      progress: counted.length
        ? Math.round(counted.reduce((sum, i) => sum + (i.status === 'error' ? 100 : i.progress), 0) / counted.length)
        : 0,
    };
  }, [items]);

  return { items, add, start, cancel, cancelAll, retry, remove, clear, uploading, progress };
}
