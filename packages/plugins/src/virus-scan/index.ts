/**
 * Virus Scanning Plugin for FluxMedia
 *
 * Scans files before upload with a scanner you provide — or the built-in
 * ClamAV (clamd) client — and rejects infected files.
 */

import {
  type FluxMediaPlugin,
  type UploadInput,
  type UploadOptions,
  MediaError,
  MediaErrorCode,
  getInputName,
} from '@fluxmedia/core';
import { connect } from 'node:net';
import { fileToBuffer, isInspectable } from '../utils';

export interface ScanResult {
  /** True when no threat was found. */
  clean: boolean;
  /** Name of the detected threat, when not clean. */
  threat?: string;
}

/**
 * Scans a file's bytes.
 */
export type VirusScanner = (
  data: Buffer,
  info: { fileName: string; contentType: string | undefined }
) => Promise<ScanResult>;

export interface VirusScanOptions {
  /** The scanner, e.g. `createClamAVScanner({ host: 'clamav' })`. */
  scan: VirusScanner;
  /**
   * What to do with stream inputs, which cannot be scanned without buffering:
   * `'reject'` (default) or `'skip'`.
   */
  streams?: 'reject' | 'skip';
  /**
   * What to do when the scanner itself fails (unreachable, timeout):
   * `'reject'` (default, fail closed) or `'allow'`.
   */
  onScannerError?: 'reject' | 'allow';
  /** Called when a threat is found. */
  onThreat?: (threat: string, fileName: string) => void;
}

/**
 * Create a virus scanning plugin.
 *
 * @example
 * ```typescript
 * await uploader.use(createVirusScanPlugin({
 *   scan: createClamAVScanner({ host: 'localhost', port: 3310 }),
 * }));
 * ```
 */
export function createVirusScanPlugin(options: VirusScanOptions): FluxMediaPlugin {
  if (typeof options?.scan !== 'function') {
    throw new Error('createVirusScanPlugin requires a scan function');
  }
  return {
    name: 'virus-scan',
    version: '1.0.0',
    hooks: {
      async beforeUpload(
        file: UploadInput,
        uploadOptions: UploadOptions
      ): Promise<{ file: UploadInput; options: UploadOptions }> {
        const fileName = getInputName(file) ?? uploadOptions.filename ?? 'unknown';
        if (!isInspectable(file)) {
          if (options.streams === 'skip') return { file, options: uploadOptions };
          throw new MediaError(
            'Streams cannot be virus scanned; upload a Buffer or File, or set streams: "skip"',
            MediaErrorCode.INVALID_FILE_TYPE,
            'virus-scan-plugin'
          );
        }

        let result: ScanResult;
        try {
          result = await options.scan(await fileToBuffer(file), {
            fileName,
            contentType: uploadOptions.contentType,
          });
        } catch (error) {
          if (options.onScannerError === 'allow') {
            console.warn('[virus-scan] Scanner failed; allowing upload:', error);
            return { file, options: uploadOptions };
          }
          throw new MediaError(
            'Virus scan failed',
            MediaErrorCode.PROVIDER_ERROR,
            'virus-scan-plugin',
            error
          );
        }

        if (!result.clean) {
          const threat = result.threat ?? 'unknown threat';
          options.onThreat?.(threat, fileName);
          throw new MediaError(
            `File rejected: ${threat} detected`,
            MediaErrorCode.INVALID_FILE_TYPE,
            'virus-scan-plugin',
            undefined,
            { threat }
          );
        }

        return {
          file,
          options: {
            ...uploadOptions,
            metadata: { ...uploadOptions.metadata, virusScan: { clean: true, scannedAt: new Date().toISOString() } },
          },
        };
      },
    },
  };
}

export interface ClamAVOptions {
  /** clamd host (default `127.0.0.1`). */
  host?: string;
  /** clamd TCP port (default 3310). */
  port?: number;
  /** Timeout in milliseconds (default 30000). */
  timeout?: number;
  /** Chunk size for INSTREAM (default 64 KB; must not exceed clamd StreamMaxLength). */
  chunkSize?: number;
}

/**
 * A scanner that talks to a ClamAV daemon (clamd) over TCP using the
 * INSTREAM command.
 */
export function createClamAVScanner(clamOptions: ClamAVOptions = {}): VirusScanner {
  const host = clamOptions.host ?? '127.0.0.1';
  const port = clamOptions.port ?? 3310;
  const timeout = clamOptions.timeout ?? 30_000;
  const chunkSize = clamOptions.chunkSize ?? 64 * 1024;

  return (data) =>
    new Promise<ScanResult>((resolve, reject) => {
      const socket = connect({ host, port });
      const response: Buffer[] = [];
      socket.setTimeout(timeout, () => socket.destroy(new Error('ClamAV scan timed out')));
      socket.on('error', reject);
      socket.on('data', (chunk) => response.push(chunk));
      socket.on('end', () => {
        const text = Buffer.concat(response).toString('utf8').replace(/\0/g, '').trim();
        // e.g. "stream: OK" or "stream: Eicar-Test-Signature FOUND"
        if (/:\s*OK$/.test(text)) return resolve({ clean: true });
        const found = text.match(/:\s*(.+)\s+FOUND$/);
        if (found) return resolve({ clean: false, threat: found[1]! });
        reject(new Error(`Unexpected ClamAV response: ${text.slice(0, 200)}`));
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let offset = 0; offset < data.length; offset += chunkSize) {
          const chunk = data.subarray(offset, offset + chunkSize);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(chunk.length, 0);
          socket.write(size);
          socket.write(chunk);
        }
        socket.end(Buffer.alloc(4)); // zero-length chunk terminates the stream
      });
    });
}
