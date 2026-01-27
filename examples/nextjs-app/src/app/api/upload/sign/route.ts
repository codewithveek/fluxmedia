import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

/**
 * API route to generate signed upload parameters for Cloudinary.
 * This allows the browser to upload directly to Cloudinary without exposing the API secret.
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { filename, folder } = body;

        const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
        const apiKey = process.env.CLOUDINARY_API_KEY;
        const apiSecret = process.env.CLOUDINARY_API_SECRET;

        if (!cloudName || !apiKey || !apiSecret) {
            return NextResponse.json(
                { error: 'Cloudinary credentials not configured' },
                { status: 500 }
            );
        }

        const timestamp = Math.round(Date.now() / 1000);
        const publicId = filename?.replace(/\.[^/.]+$/, '') ?? `upload_${timestamp}`;

        // Build the string to sign
        const paramsToSign: Record<string, string | number> = {
            timestamp,
            ...(folder && { folder }),
            ...(publicId && { public_id: publicId }),
        };

        // Create signature
        const sortedParams = Object.keys(paramsToSign)
            .sort()
            .map((key) => `${key}=${paramsToSign[key]}`)
            .join('&');

        const signature = crypto
            .createHash('sha1')
            .update(sortedParams + apiSecret)
            .digest('hex');

        return NextResponse.json({
            uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`,
            publicId,
            fields: {
                api_key: apiKey,
                timestamp,
                signature,
                ...(folder && { folder }),
                ...(publicId && { public_id: publicId }),
            },
        });
    } catch (error) {
        console.error('Sign error:', error);
        return NextResponse.json(
            { error: 'Failed to generate signed URL' },
            { status: 500 }
        );
    }
}
