"use client";

import { useMemo } from "react";
import { MermaidDiagram } from "./mermaid-diagram";

interface BlogContentProps {
    htmlContent: string;
}

export function BlogContent({ htmlContent }: BlogContentProps) {
    // Split content by mermaid code blocks and render them as components
    const parts = useMemo(() => {
        // Match mermaid code blocks: <pre><code class="language-mermaid">...</code></pre>
        // or shiki-rendered blocks with language-mermaid
        const mermaidRegex = /<pre[^>]*><code[^>]*class="[^"]*language-mermaid[^"]*"[^>]*>([\s\S]*?)<\/code><\/pre>/gi;

        const result: Array<{ type: "html" | "mermaid"; content: string }> = [];
        let lastIndex = 0;
        let match;

        while ((match = mermaidRegex.exec(htmlContent)) !== null) {
            // Add HTML before the mermaid block
            if (match.index > lastIndex) {
                result.push({
                    type: "html",
                    content: htmlContent.slice(lastIndex, match.index),
                });
            }

            // Decode HTML entities in mermaid content
            const mermaidCode = match[1]
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">")
                .replace(/&amp;/g, "&")
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .trim();

            result.push({
                type: "mermaid",
                content: mermaidCode,
            });

            lastIndex = match.index + match[0].length;
        }

        // Add remaining HTML after last mermaid block
        if (lastIndex < htmlContent.length) {
            result.push({
                type: "html",
                content: htmlContent.slice(lastIndex),
            });
        }

        return result;
    }, [htmlContent]);

    // If no mermaid blocks found, render as plain HTML
    if (parts.length === 0 || (parts.length === 1 && parts[0].type === "html")) {
        return (
            <div
                className="blog-content"
                dangerouslySetInnerHTML={{ __html: htmlContent }}
            />
        );
    }

    return (
        <div className="blog-content">
            {parts.map((part, index) => {
                if (part.type === "mermaid") {
                    return <MermaidDiagram key={index} chart={part.content} />;
                }
                return (
                    <div
                        key={index}
                        dangerouslySetInnerHTML={{ __html: part.content }}
                    />
                );
            })}
        </div>
    );
}
