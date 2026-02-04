"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";

export default function PlaygroundPage() {
    const [loading, setLoading] = useState(true);

    return (
        <div className="container py-6 h-[calc(100vh-3.5rem)] flex flex-col max-w-7xl">
            <div className="mb-4">
                <h1 className="text-2xl font-bold">Playground</h1>
                <p className="text-muted-foreground">
                    Try FluxMedia in a live Node.js environment via StackBlitz.
                </p>
            </div>

            <div className="flex-1 rounded-xl border border-border/40 bg-zinc-950 overflow-hidden relative shadow-2xl">
                {loading && (
                    <div className="absolute inset-0 flex items-center justify-center bg-zinc-950 text-zinc-500 z-0">
                        <Loader2 className="h-8 w-8 animate-spin" />
                        <span className="ml-3">Loading StackBlitz...</span>
                    </div>
                )}
                <iframe
                    src="https://stackblitz.com/edit/node-experimental?embed=1&file=index.js&hideExplorer=1&hideNavigation=1&view=editor"
                    className="w-full h-full border-0 relative z-10"
                    title="FluxMedia Playground"
                    onLoad={() => setLoading(false)}
                    allow="accelerometer; ambient-light-sensor; camera; encrypted-media; geolocation; gyroscope; hid; microphone; midi; payment; usb; vr; xr-spatial-tracking"
                    sandbox="allow-forms allow-modals allow-popups allow-presentation allow-same-origin allow-scripts"
                />
            </div>
        </div>
    );
}
