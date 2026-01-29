import type {
    MediaProvider,
    UploadOptions,
    UploadResult,
    TransformationOptions,
    SearchOptions,
} from './types';
import { PluginManager, type FluxMediaPlugin } from './plugin';

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
 * // Register plugins
 * uploader.use({
 *   name: 'logger',
 *   hooks: {
 *     beforeUpload: async (file, options) => {
 *       console.log('Uploading:', file);
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
     * Create a new MediaUploader instance.
     *
     * @param provider - Provider implementation (e.g., CloudinaryProvider, S3Provider)
     * @param plugins - Optional array of plugins to register on creation
     */
    constructor(provider: MediaProvider, plugins?: FluxMediaPlugin[]) {
        this.provider = provider;
        this.plugins = new PluginManager();

        // Register initial plugins if provided
        if (plugins?.length) {
            // Use sync registration for constructor (plugins can use async init)
            for (const plugin of plugins) {
                this.plugins.register(plugin);
            }
        }
    }

    /**
     * Register a plugin.
     * If a plugin with the same name exists, it will be overridden (last takes precedence).
     *
     * @param plugin - Plugin to register
     * @returns Promise resolving to this uploader for chaining
     *
     * @example
     * ```typescript
     * await uploader
     *   .use(loggerPlugin)
     *   .use(compressionPlugin)
     *   .use(validationPlugin);
     * ```
     */
    async use(plugin: FluxMediaPlugin): Promise<this> {
        await this.plugins.register(plugin);
        return this;
    }

    /**
     * Upload a file to the configured provider.
     * Runs beforeUpload and afterUpload plugin hooks.
     *
     * @param file - File to upload (browser File or Node.js Buffer)
     * @param options - Upload options
     * @returns Promise resolving to upload result
     * @throws {MediaError} If upload fails
     */
    async upload(file: File | Buffer, options?: UploadOptions): Promise<UploadResult> {
        // Run beforeUpload hooks
        const { file: processedFile, options: processedOptions } =
            await this.plugins.runBeforeUpload(file, options ?? {});

        try {
            // Perform the actual upload
            let result = await this.provider.upload(processedFile, processedOptions);

            // Run afterUpload hooks
            result = await this.plugins.runAfterUpload(result);

            return result;
        } catch (error) {
            // Run onError hooks
            await this.plugins.runOnError(
                error instanceof Error ? error : new Error(String(error)),
                { file: processedFile, options: processedOptions }
            );
            throw error;
        }
    }

    /**
     * Delete a file by its ID.
     * Runs beforeDelete and afterDelete plugin hooks.
     *
     * @param id - File identifier from upload result
     * @returns Promise that resolves when deletion is complete
     * @throws {MediaError} If deletion fails
     */
    async delete(id: string): Promise<void> {
        // Run beforeDelete hooks
        const processedId = await this.plugins.runBeforeDelete(id);

        await this.provider.delete(processedId);

        // Run afterDelete hooks
        await this.plugins.runAfterDelete(processedId);
    }

    /**
     * Get metadata for a file.
     *
     * @param id - File identifier
     * @returns Promise resolving to file metadata
     * @throws {MediaError} If file not found
     */
    async get(id: string): Promise<UploadResult> {
        return this.provider.get(id);
    }

    /**
     * Generate a URL for accessing a file, optionally with transformations.
     * Runs beforeGetUrl plugin hooks.
     *
     * @param id - File identifier
     * @param transform - Optional transformation options
     * @returns URL string
     */
    getUrl(id: string, transform?: TransformationOptions): string {
        // Note: This is sync so we can't run async hooks here.
        // For async URL generation, use getUrlAsync.
        return this.provider.getUrl(id, transform);
    }

    /**
     * Generate a URL with async plugin hook support.
     *
     * @param id - File identifier
     * @param transform - Optional transformation options
     * @returns Promise resolving to URL string
     */
    async getUrlAsync(id: string, transform?: TransformationOptions): Promise<string> {
        const { id: processedId, transform: processedTransform } =
            await this.plugins.runBeforeGetUrl(id, transform);

        return this.provider.getUrl(processedId, processedTransform);
    }

    /**
     * Upload multiple files in batch.
     *
     * @param files - Array of files to upload
     * @param options - Upload options (applied to all files)
     * @returns Promise resolving to array of upload results
     * @throws {MediaError} If any upload fails
     */
    async uploadMultiple(
        files: File[] | Buffer[],
        options?: UploadOptions
    ): Promise<UploadResult[]> {
        // Use individual upload to ensure plugins run for each file
        const results: UploadResult[] = [];
        for (const file of files) {
            results.push(await this.upload(file, options));
        }
        return results;
    }

    /**
     * Delete multiple files in batch.
     *
     * @param ids - Array of file identifiers
     * @returns Promise that resolves when all deletions are complete
     * @throws {MediaError} If any deletion fails
     */
    async deleteMultiple(ids: string[]): Promise<void> {
        // Use individual delete to ensure plugins run for each file
        for (const id of ids) {
            await this.delete(id);
        }
    }

    /**
     * Search for files (if provider supports search).
     *
     * @param query - Search options
     * @returns Promise resolving to matching files
     * @throws {MediaError} If search fails or not supported
     */
    async search(query: SearchOptions): Promise<UploadResult[]> {
        if (!this.provider.search) {
            throw new Error(`Search is not supported by ${this.provider.name} provider`);
        }
        return this.provider.search(query);
    }

    /**
     * Check if the provider supports a specific feature.
     *
     * @param feature - Feature path (e.g., 'transformations.resize')
     * @returns Whether the feature is supported
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
}