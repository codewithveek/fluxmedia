import { NextRequest, NextResponse } from 'next/server';
import { MediaUploader } from '@fluxmedia/core';
import { CloudinaryProvider } from '@fluxmedia/cloudinary';

/**
 * API route for proxy uploads.
 * The file is uploaded to the server first, then uploaded to Cloudinary.
 */
export async function POST(request: NextRequest) {
    try {
        const formData = await request.formData();
        const file = formData.get('file') as File;
        const folder = formData.get('folder') as string | null;

        if (!file) {
            return NextResponse.json({ error: 'No file provided' }, { status: 400 });
        }

        const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
        const apiKey = process.env.CLOUDINARY_API_KEY;
        const apiSecret = process.env.CLOUDINARY_API_SECRET;

        if (!cloudName || !apiKey || !apiSecret) {
            return NextResponse.json(
                { error: 'Cloudinary credentials not configured' },
                { status: 500 }
            );
        }

        // Create uploader with Cloudinary provider
        const uploader = new MediaUploader(
            new CloudinaryProvider({
                cloudName,
                apiKey,
                apiSecret,
            })
        );

        // Convert File to Buffer
        const buffer = Buffer.from(await file.arrayBuffer());

        // Upload to Cloudinary
        const result = await uploader.upload(buffer, {
            folder: folder ?? undefined,
            filename: file.name.replace(/\.[^/.]+$/, ''),
        });

        return NextResponse.json(result);
    } catch (error) {
        console.error('Upload error:', error);
        return NextResponse.json(
            { error: 'Upload failed' },
            { status: 500 }
        );
    }
}

// Configure to allow larger file uploads
export const config = {
    api: {
        bodyParser: false,
    },
};
