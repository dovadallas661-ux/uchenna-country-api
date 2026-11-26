require("dotenv").config();

const express = require("express");
const countryRoutes = require("./routes/countryRoutes");
const db = require("./config/db");

const app = express();

app.use(express.json());

app.use((error, req, res, next) => {
    if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
        return res.status(400).json({ error: "Validation failed", details: { body: "must contain valid JSON" } });
    }
    return next(error);
});

app.use("/countries", countryRoutes);

app.get("/status", async (req, res) => {
    try {
        const [rows] = await db.execute(`
            SELECT
                (SELECT COUNT(*) FROM countries) AS total_countries,
                last_refreshed_at
            FROM app_status
            WHERE id = 1
        `);

        if (!rows.length) {
            return res.status(500).json({
                error: "Internal server error"
            });
        }

        res.json(rows[0]);
    } catch (error) {
        console.error("Status request failed:", {
            code: error.code,
            message: error.message
        });

        res.status(500).json({
            error: "Internal server error"
        });
    }
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on port ${PORT}`);
    });
}
module.exports = app;
