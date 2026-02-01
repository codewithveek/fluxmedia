import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

type ProviderType = 'cloudinary' | 's3' | 'r2';

/**
 * API route to generate signed upload URLs for multiple providers.
 * Supports Cloudinary, S3, and R2.
 */
export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { filename, contentType, folder, provider = 'cloudinary' } = body;

        if (!filename || !contentType) {
            return NextResponse.json(
                { error: 'Missing filename or contentType' },
                { status: 400 }
            );
        }

        switch (provider as ProviderType) {
            case 'cloudinary':
                return handleCloudinarySign(filename, folder);
            case 's3':
                return handleS3Sign(filename, contentType, folder);
            case 'r2':
                return handleR2Sign(filename, contentType, folder);
            default:
                return NextResponse.json(
                    { error: `Unknown provider: ${provider}` },
                    { status: 400 }
                );
        }
    } catch (error) {
        console.error('Sign error:', error);
        return NextResponse.json(
            { error: 'Failed to generate signed URL' },
            { status: 500 }
        );
    }
}

/**
 * Generate Cloudinary signed upload parameters
 */
async function handleCloudinarySign(filename: string, folder?: string) {
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
}

/**
 * Generate S3 pre-signed upload URL
 */
async function handleS3Sign(
    filename: string,
    contentType: string,
    folder?: string
) {
    const region = process.env.AWS_REGION;
    const bucket = process.env.AWS_BUCKET;
    const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

    if (!region || !bucket || !accessKeyId || !secretAccessKey) {
        return NextResponse.json(
            { error: 'AWS credentials not configured' },
            { status: 500 }
        );
    }

    const client = new S3Client({
        region,
        credentials: { accessKeyId, secretAccessKey },
    });

    const key = folder ? `${folder}/${filename}` : filename;

    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(client, command, {
        expiresIn: 3600, // 1 hour
    });

    // S3 uses PUT for signed uploads
    return NextResponse.json({
        uploadUrl,
        publicId: key,
        method: 'PUT', // Important: S3 uses PUT, not POST
        headers: {
            'Content-Type': contentType,
        },
    });
}

/**
 * Generate R2 pre-signed upload URL (S3-compatible)
 */
async function handleR2Sign(
    filename: string,
    contentType: string,
    folder?: string
) {
    const accountId = process.env.R2_ACCOUNT_ID;
    const bucket = process.env.R2_BUCKET;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const publicUrl = process.env.R2_PUBLIC_URL;

    if (!accountId || !bucket || !accessKeyId || !secretAccessKey) {
        return NextResponse.json(
            { error: 'R2 credentials not configured' },
            { status: 500 }
        );
    }

    // R2 uses S3-compatible API
    const client = new S3Client({
        region: 'auto',
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId, secretAccessKey },
    });

    const key = folder ? `${folder}/${filename}` : filename;

    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(client, command, {
        expiresIn: 3600, // 1 hour
    });

    // Build public URL for access after upload
    const resultPublicUrl = publicUrl
        ? `${publicUrl}/${key}`
        : undefined;

    return NextResponse.json({
        uploadUrl,
        publicId: key,
        publicUrl: resultPublicUrl,
        method: 'PUT', // R2 uses PUT, not POST
        headers: {
            'Content-Type': contentType,
        },
    });
}
