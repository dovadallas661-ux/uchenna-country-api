const db = require("../config/db");

async function main() {
    try {
        const [rows] = await db.query("SELECT 1 AS connected");
        if (rows[0]?.connected !== 1) {
            throw new Error("Database returned an unexpected response");
        }
        console.log("Database connection successful (SELECT 1).");
    } catch (error) {
        // Do not print driver messages: they can include connection details.
        console.error(`Database connection failed${error.code ? ` (${error.code})` : ""}. Check DB_HOST, DB_PORT, credentials, and network access.`);
        process.exitCode = 1;
    } finally {
        await db.end();
    }
}

main();
