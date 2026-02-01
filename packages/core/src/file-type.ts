/**
 * File type detection utility using magic bytes.
 * Uses file-type library with load-esm for CJS compatibility.
 */

import type { Readable } from 'stream';

/**
 * Result from file type detection
 */
export interface FileTypeResult {
    /**
     * MIME type of the file (e.g., 'image/png', 'video/mp4')
     */
    mime: string;

    /**
     * File extension (without leading dot, e.g., 'png', 'mp4')
     */
    ext: string;
}

// Lazy-loaded file-type module
let fileTypeModule: typeof import('file-type') | null = null;

/**
 * Load file-type module dynamically (ESM module in CJS context)
 */
async function loadFileType(): Promise<typeof import('file-type')> {
    if (fileTypeModule) {
        return fileTypeModule;
    }

    try {
        // Try direct ESM import first (works in ESM context)
        fileTypeModule = await import('file-type');
        return fileTypeModule;
    } catch {
        // Fall back to load-esm for CJS context
        const { loadEsm } = await import('load-esm');
        fileTypeModule = await loadEsm<typeof import('file-type')>('file-type');
        return fileTypeModule;
    }
}

/**
 * Detect file type from a Buffer using magic bytes.
 * More reliable than file extension or MIME type from browser.
 *
 * @param buffer - File content as Buffer
 * @returns FileTypeResult or null if type cannot be determined
 *
 * @example
 * ```typescript
 * const buffer = await fs.readFile('image.jpg');
 * const type = await getFileType(buffer);
 * console.log(type); // { mime: 'image/jpeg', ext: 'jpg' }
 * ```
 */
export async function getFileType(buffer: Buffer | Uint8Array): Promise<FileTypeResult | null> {
    const ft = await loadFileType();
    const result = await ft.fileTypeFromBuffer(buffer);

    if (!result) {
        return null;
    }

    return {
        mime: result.mime,
        ext: result.ext,
    };
}

/**
 * Detect file type from a readable stream.
 * Useful for large files without loading entire content into memory.
 *
 * @param stream - Readable stream of file content (Node.js Readable or Web ReadableStream)
 * @returns FileTypeResult or null if type cannot be determined
 */
export async function getFileTypeFromStream(stream: Readable | ReadableStream<Uint8Array>): Promise<FileTypeResult | null> {
    const ft = await loadFileType();

    // Convert Node.js Readable to Web ReadableStream if needed
    let webStream: ReadableStream<Uint8Array>;
    if ('pipe' in stream && typeof (stream as Readable).pipe === 'function') {
        // It's a Node.js Readable stream, convert to Web ReadableStream
        const { Readable } = await import('stream');
        webStream = Readable.toWeb(stream as Readable) as ReadableStream<Uint8Array>;
    } else {
        // Already a Web ReadableStream
        webStream = stream as ReadableStream<Uint8Array>;
    }

    const result = await ft.fileTypeFromStream(webStream);

    if (!result) {
        return null;
    }

    return {
        mime: result.mime,
        ext: result.ext,
    };
}

/**
 * Check if a buffer represents an image file.
 *
 * @param buffer - File content as Buffer
 * @returns true if the file is an image
 */
export async function isImage(buffer: Buffer | Uint8Array): Promise<boolean> {
    const result = await getFileType(buffer);
    return result?.mime.startsWith('image/') ?? false;
}

/**
 * Check if a buffer represents a video file.
 *
 * @param buffer - File content as Buffer
 * @returns true if the file is a video
 */
export async function isVideo(buffer: Buffer | Uint8Array): Promise<boolean> {
    const result = await getFileType(buffer);
    return result?.mime.startsWith('video/') ?? false;
}
