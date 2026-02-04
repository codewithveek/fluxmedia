"use client";

import { useEffect, useState } from "react";
import { codeToHtml } from "shiki";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

const OLD_WAY = `// Traditional approach: AWS SDK v3 (Verbose)
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const client = new S3Client({
  region: "us-east-1",
  credentials: { accessKeyId: "...", secretAccessKey: "..." }
});

// Uploading requires manual stream handling & command setup
const command = new PutObjectCommand({
  Bucket: "my-bucket",
  Key: "uploads/avatar.png",
  Body: fileStream,
  ContentType: "image/png"
});

await client.send(command);`;

const FLUX_WAY = `// With FluxMedia: Unified & Type-Safe
import { MediaUploader } from "@fluxmedia/core";
import { S3Provider } from "@fluxmedia/s3";

const uploader = new MediaUploader(
  new S3Provider({
    region: "us-east-1",
    bucket: "my-bucket",
    accessKeyId: "...",
    secretAccessKey: "..."
  })
);

// Works the same for S3, R2, or Cloudinary!
await uploader.upload(file, {
  folder: "uploads",
  metadata: { type: "avatar" }
});`;

export function CodeComparison() {
    const [oldHtml, setOldHtml] = useState("");
    const [fluxHtml, setFluxHtml] = useState("");
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        async function highlight() {
            const old = await codeToHtml(OLD_WAY, {
                lang: "typescript",
                theme: "github-dark",
            });
            const flux = await codeToHtml(FLUX_WAY, {
                lang: "typescript",
                theme: "github-dark",
            });
            setOldHtml(old);
            setFluxHtml(flux);
        }
        highlight();
    }, []);

    const copyCode = () => {
        navigator.clipboard.writeText(FLUX_WAY);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 lg:gap-8 max-w-5xl mx-auto">
            <div className="rounded-xl border bg-zinc-950 p-4 shadow-2xl overflow-hidden">
                <div className="flex items-center justify-between mb-4 border-b border-zinc-800 pb-2">
                    <div className="flex space-x-2">
                        <div className="h-3 w-3 rounded-full bg-red-500/20" />
                        <div className="h-3 w-3 rounded-full bg-yellow-500/20" />
                        <div className="h-3 w-3 rounded-full bg-green-500/20" />
                    </div>
                    <span className="text-xs font-medium text-zinc-500">The "Old" Way</span>
                </div>
                <div
                    className="text-sm font-mono overflow-x-auto [&>pre]:bg-transparent! [&>pre]:p-0"
                    dangerouslySetInnerHTML={{ __html: oldHtml || "<div class='text-zinc-500'>Loading...</div>" }}
                />
            </div>

            <div className="relative rounded-xl border border-indigo-500/30 bg-zinc-950 p-4 shadow-2xl shadow-indigo-500/10 overflow-hidden ring-1 ring-indigo-500/20">
                <div className="flex items-center justify-between mb-4 border-b border-zinc-800 pb-2">
                    <div className="flex space-x-2">
                        <div className="h-3 w-3 rounded-full bg-red-500" />
                        <div className="h-3 w-3 rounded-full bg-yellow-500" />
                        <div className="h-3 w-3 rounded-full bg-green-500" />
                    </div>
                    <span className="text-xs font-medium text-indigo-400">FluxMedia Way ✨</span>
                </div>
                <div
                    className="text-sm font-mono overflow-x-auto [&>pre]:bg-transparent! [&>pre]:p-0"
                    dangerouslySetInnerHTML={{ __html: fluxHtml || "<div class='text-zinc-500'>Loading...</div>" }}
                />
                <Button
                    size="icon"
                    variant="ghost"
                    className="absolute top-3 right-3 h-8 w-8 text-zinc-400 hover:text-white hover:bg-zinc-800"
                    onClick={copyCode}
                >
                    {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
                </Button>
            </div>
        </div>
    );
}
