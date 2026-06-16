import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

export async function checkDatabaseConnection() {
    const result = await pool.query("select now() as now");
    return result.rows[0];
}
