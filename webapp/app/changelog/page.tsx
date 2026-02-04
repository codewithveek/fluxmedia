import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function ChangelogPage() {
    return (
        <div className="container py-24 text-center max-w-2xl">
            <div className="mb-8 p-4 rounded-full bg-emerald-500/10 text-emerald-500 inline-block w-16 h-16 flex items-center justify-center mx-auto">
                <span className="text-2xl">🚀</span>
            </div>
            <h1 className="text-4xl font-bold mb-4">Changelog</h1>
            <p className="text-muted-foreground text-lg mb-8">
                Track the latest updates and improvements to FluxMedia.
            </p>

            <div className="group rounded-lg border border-border bg-card p-6 text-left mb-8 shadow-sm hover:shadow-md transition-all">
                <div className="flex items-center justify-between mb-4">
                    <div className="bg-indigo-500/10 text-indigo-500 px-3 py-1 rounded-full text-xs font-semibold">v0.1.0</div>
                    <span className="text-sm text-muted-foreground">Feb 3, 2026</span>
                </div>
                <h2 className="text-xl font-semibold mb-2">Initial Release</h2>
                <ul className="list-disc list-inside text-muted-foreground space-y-1 text-sm">
                    <li>Unified API for Cloudinary, S3, and R2</li>
                    <li>TypeScript-first architecture</li>
                    <li>Plugin system active</li>
                </ul>
            </div>

            <Button variant="outline" asChild>
                <Link href="/">
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    Back Home
                </Link>
            </Button>
        </div>
    );
}
