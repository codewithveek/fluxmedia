'use client';

import { useState } from 'react';
import { useMediaUpload, type UploadMode } from '@fluxmedia/react';

export default function Home() {
    const [mode, setMode] = useState<UploadMode>('signed');

    const { upload, uploading, progress, result, error, reset } = useMediaUpload({
        mode,
        signUrlEndpoint: '/api/upload/sign',
        proxyEndpoint: '/api/upload',
        onUploadComplete: (result) => {
            console.log('Upload complete:', result);
        },
        onUploadError: (error) => {
            console.error('Upload error:', error);
        },
    });

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        try {
            await upload(file, { folder: 'nextjs-demo' });
        } catch (err) {
            // Error is handled by onUploadError
        }
    };

    return (
        <main className="container">
            <h1>FluxMedia</h1>
            <p className="subtitle">Provider-agnostic media uploads for Next.js</p>

            <div className="card">
                <h2>Upload Mode</h2>
                <div className="mode-tabs">
                    <button
                        className={`mode-tab ${mode === 'signed' ? 'active' : ''}`}
                        onClick={() => { setMode('signed'); reset(); }}
                    >
                        Signed URL
                    </button>
                    <button
                        className={`mode-tab ${mode === 'proxy' ? 'active' : ''}`}
                        onClick={() => { setMode('proxy'); reset(); }}
                    >
                        Proxy
                    </button>
                </div>

                <p style={{ color: '#888', fontSize: '0.875rem', marginBottom: '1rem' }}>
                    {mode === 'signed'
                        ? 'Get a signed URL from the server, then upload directly to Cloudinary.'
                        : 'Upload through the Next.js server (slower but more control).'}
                </p>

                <div className="upload-zone">
                    <input
                        type="file"
                        accept="image/*"
                        onChange={handleFileSelect}
                        disabled={uploading}
                        style={{ display: 'none' }}
                        id="file-input"
                    />
                    <label htmlFor="file-input">
                        <button
                            className="upload-button"
                            onClick={() => document.getElementById('file-input')?.click()}
                            disabled={uploading}
                        >
                            {uploading ? `Uploading... ${progress}%` : '📁 Select Image'}
                        </button>
                    </label>

                    {uploading && (
                        <div className="progress-bar">
                            <div
                                className="progress-bar-fill"
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                    )}
                </div>

                {error && (
                    <div className="error">
                        ❌ {error.message}
                    </div>
                )}

                {result && (
                    <div className="result">
                        <strong>✅ Upload Complete!</strong>
                        <div className="url-display">{result.url}</div>
                        <img src={result.url} alt="Uploaded" />
                    </div>
                )}
            </div>

            <div className="card">
                <h2>How It Works</h2>
                <pre style={{
                    background: '#0a0a0a',
                    padding: '1rem',
                    borderRadius: '8px',
                    overflow: 'auto',
                    fontSize: '0.875rem'
                }}>
                    {`import { useMediaUpload } from '@fluxmedia/react';

const { upload, uploading, progress, result } = useMediaUpload({
  mode: '${mode}',
  ${mode === 'signed' ? "signUrlEndpoint: '/api/upload/sign'" : "proxyEndpoint: '/api/upload'"}
});

// Upload a file
await upload(file, { folder: 'my-uploads' });`}
                </pre>
            </div>
        </main>
    );
}
