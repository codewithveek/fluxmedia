import type { Config } from "tailwindcss";

const config: Config = {
    // Tailwind 4 relies on CSS variables for theme configuration.
    // We keep the detailed theme in globals.css using the @theme directive.
    content: [
        "./app/**/*.{js,ts,jsx,tsx,mdx}",
        "./components/**/*.{js,ts,jsx,tsx,mdx}",
        "./lib/**/*.{js,ts,jsx,tsx,mdx}",
    ],
    plugins: [],
};
export default config;
