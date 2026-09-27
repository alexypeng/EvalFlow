import { afterAll } from "vitest";
import { prisma } from "../../src/db.js";

afterAll(async () => {
    await prisma.$disconnect();
});
