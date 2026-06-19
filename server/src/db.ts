import "dotenv/config";
import { PrismaClient } from "./generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
});

export const prisma = new PrismaClient({
    adapter,
});

export async function checkDatabaseConnection() {
    const result = await prisma.$queryRaw<Array<{ now: Date }>>`
        SELECT now() as now
    `;

    return result[0];
}
