"use client";

import { useEffect, useRef, useState } from "react";
import mermaid from "mermaid";

interface MermaidDiagramProps {
    chart: string;
}

// Initialize mermaid with dark theme
mermaid.initialize({
    startOnLoad: false,
    theme: "dark",
    themeVariables: {
        primaryColor: "#6366f1",
        primaryTextColor: "#fff",
        primaryBorderColor: "#4f46e5",
        lineColor: "#a5b4fc",
        secondaryColor: "#1e1b4b",
        tertiaryColor: "#312e81",
        background: "#18181b",
        mainBkg: "#27272a",
        secondBkg: "#3f3f46",
        nodeBorder: "#6366f1",
        clusterBkg: "#27272a",
        clusterBorder: "#4f46e5",
        titleColor: "#e5e7eb",
        edgeLabelBackground: "#27272a",
    },
    flowchart: {
        htmlLabels: true,
        curve: "basis",
    },
});

export function MermaidDiagram({ chart }: MermaidDiagramProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [svg, setSvg] = useState<string>("");
    const [error, setError] = useState<string>("");

    useEffect(() => {
        async function renderChart() {
            if (!containerRef.current || !chart) return;

            try {
                const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
                const { svg: renderedSvg } = await mermaid.render(id, chart);
                setSvg(renderedSvg);
                setError("");
            } catch (err) {
                console.error("Mermaid rendering error:", err);
                setError("Failed to render diagram");
            }
        }

        renderChart();
    }, [chart]);

    if (error) {
        return (
            <div className="my-6 p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                {error}
            </div>
        );
    }

    return (
        <div
            ref={containerRef}
            className="my-6 p-4 rounded-lg bg-zinc-900 border border-zinc-800 overflow-x-auto flex justify-center"
            dangerouslySetInnerHTML={{ __html: svg }}
        />
    );
}
