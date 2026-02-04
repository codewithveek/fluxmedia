export interface ProjectMetrics {
    stars: number;
    downloads: number;
}

export async function getProjectMetrics(): Promise<ProjectMetrics> {
    let stars = 0;
    let downloads = 0;

    try {
        const githubRes = await fetch("https://api.github.com/repos/codewithveek/fluxmedia", {
            next: { revalidate: 3600 }, // Cache for 1 hour
        });
        if (githubRes.ok) {
            const data = await githubRes.json();
            stars = data.stargazers_count;
        }
    } catch (error) {
        console.error("Failed to fetch GitHub stars:", error);
    }

    try {
        const npmRes = await fetch("https://api.npmjs.org/downloads/point/last-week/@fluxmedia/core", {
            next: { revalidate: 3600 },
        });
        if (npmRes.ok) {
            const data = await npmRes.json();
            downloads = data.downloads;
        }
    } catch (error) {
        console.error("Failed to fetch NPM downloads:", error);
    }

    return { stars, downloads };
}

export function formatMetric(num: number): string {
    if (num > 1000) {
        return (num / 1000).toFixed(1) + "k";
    }
    return num.toString();
}
