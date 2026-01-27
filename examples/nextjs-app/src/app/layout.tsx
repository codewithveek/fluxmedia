import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
    title: 'FluxMedia Next.js Example',
    description: 'Demonstration of FluxMedia with Next.js',
};

export default function RootLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <html lang="en">
            <body>{children}</body>
        </html>
    );
}
