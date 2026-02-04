import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function BlogPage() {
    return (
        <div className="container py-24 text-center max-w-2xl">
            <div className="mb-8 p-4 rounded-full bg-indigo-500/10 text-indigo-500 inline-block w-16 h-16 flex items-center justify-center mx-auto">
                <span className="text-2xl">✍️</span>
            </div>
            <h1 className="text-4xl font-bold mb-4">Blog</h1>
            <p className="text-muted-foreground text-lg mb-8">
                Detailed guides, tutorials, and engineering deep dives are coming soon.
            </p>
            <Button variant="outline" asChild>
                <Link href="/">
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    Back Home
                </Link>
            </Button>
        </div>
    );
}
