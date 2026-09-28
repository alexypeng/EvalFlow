import "dotenv/config";
import { loadDataset, readDatasetFile } from "./datasets.js";
import { prisma } from "./db.js";

// Usage: pnpm --filter server dataset:load datasets/retention-v1.json
const path = process.argv[2];

if (!path) {
    console.error("Usage: pnpm --filter server dataset:load <dataset.json>");
    process.exit(1);
}

try {
    const file = await readDatasetFile(path);
    const result = await loadDataset(file);

    console.log(
        result.status === "created"
            ? `Loaded ${file.name} v${file.version}: ${result.caseCount} cases (${result.datasetId})`
            : `${file.name} v${file.version} is already loaded and unchanged (${result.datasetId})`,
    );
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
