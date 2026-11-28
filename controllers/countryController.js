const db = require("../config/db");
const {
    refreshCountries,
    saveCountries
} = require("../services/countryService");
const generateSummaryImage = require("../services/imageService");
const { SUMMARY_IMAGE_PATH } = require("../services/imageService");
const fs = require("fs");

const SORT_OPTIONS = {
    gdp_desc: "estimated_gdp DESC",
    gdp_asc: "estimated_gdp ASC",
    population_desc: "population DESC",
    population_asc: "population ASC",
    name_asc: "name ASC"
};

function sendError(res, error) {
    if (error.code === "REST_COUNTRIES_API_KEY_MISSING") {
        return res.status(500).json({
            error: "Configuration error",
            details: error.message
        });
    }

    if (error.statusCode === 400) {
        return res.status(400).json({
            error: "Validation failed",
            details: error.details || {}
        });
    }

    if (error.statusCode === 503) {
        return res.status(503).json({
            error: "External data source unavailable",
            details: "Could not fetch country or exchange rate data"
        });
    }

    console.error("Request failed:", {
        code: error.code,
        message: error.message
    });

    return res.status(500).json({
        error: "Internal server error"
    });
}

function validateBody(body, partial = false) {
    const details = {};
    const allowed = ["name", "capital", "region", "population", "currency_code", "exchange_rate", "estimated_gdp", "flag_url"];
    if (!body || typeof body !== "object" || Array.isArray(body)) return { body: "must be a JSON object" };
    for (const key of Object.keys(body)) if (!allowed.includes(key)) details[key] = "is not allowed";
    if (!partial || Object.hasOwn(body, "name")) {
        if (typeof body.name !== "string" || !body.name.trim()) details.name = "must be a non-empty string";
    }
    if (!partial || Object.hasOwn(body, "population")) {
        if (body.population === undefined || body.population === null || body.population === "" || !Number.isSafeInteger(Number(body.population)) || Number(body.population) < 0) details.population = "must be a non-negative whole number";
    }
    for (const key of ["capital", "region", "currency_code", "flag_url"]) {
        if (Object.hasOwn(body, key) && body[key] !== null && typeof body[key] !== "string") details[key] = "must be a string or null";
    }
    for (const key of ["exchange_rate", "estimated_gdp"]) {
        if (Object.hasOwn(body, key) && body[key] !== null && (!Number.isFinite(Number(body[key])) || Number(body[key]) < 0)) details[key] = "must be a non-negative number or null";
    }
    return Object.keys(details).length ? details : null;
}

exports.createCountry = async (req, res) => {
    const details = validateBody(req.body);
    if (details) return res.status(400).json({ error: "Validation failed", details });
    const b = req.body;
    try {
        const [result] = await db.execute(`INSERT INTO countries (name, capital, region, population, currency_code, exchange_rate, estimated_gdp, flag_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [b.name.trim(), b.capital ?? null, b.region ?? null, b.population, b.currency_code ?? null, b.exchange_rate ?? null, b.estimated_gdp ?? null, b.flag_url ?? null]);
        const [rows] = await db.execute("SELECT * FROM countries WHERE id = ?", [result.insertId]);
        return res.status(201).json(rows[0]);
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Country already exists" });
        return sendError(res, error);
    }
};

exports.updateCountry = async (req, res) => {
    const details = validateBody(req.body, true);
    if (details) return res.status(400).json({ error: "Validation failed", details });
    const fields = Object.keys(req.body);
    if (!fields.length) return res.status(400).json({ error: "Validation failed", details: { body: "must contain at least one field" } });
    const columns = { name: "name", capital: "capital", region: "region", population: "population", currency_code: "currency_code", exchange_rate: "exchange_rate", estimated_gdp: "estimated_gdp", flag_url: "flag_url" };
    try {
        const [result] = await db.execute(`UPDATE countries SET ${fields.map((key) => `${columns[key]} = ?`).join(", ")} WHERE LOWER(name) = LOWER(?)`, [...fields.map((key) => key === "name" && typeof req.body[key] === "string" ? req.body[key].trim() : req.body[key]), req.params.name]);
        if (!result.affectedRows) {
            const [rows] = await db.execute("SELECT id FROM countries WHERE LOWER(name) = LOWER(?)", [req.params.name]);
            if (!rows.length) return res.status(404).json({ error: "Country not found" });
        }
        const [rows] = await db.execute("SELECT * FROM countries WHERE LOWER(name) = LOWER(?) LIMIT 1", [req.body.name || req.params.name]);
        return res.json(rows[0]);
    } catch (error) {
        if (error.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Country already exists" });
        return sendError(res, error);
    }
};

exports.refresh = async (req, res) => {
    try {
        const countries = await refreshCountries();
        await saveCountries(countries);
        await generateSummaryImage();

        res.status(200).json({
            message: "Countries refreshed successfully",
            total_countries: countries.length
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.getCountries = async (req, res) => {
    try {
        const { region, currency, sort } = req.query;

        if (sort && !SORT_OPTIONS[sort]) {
            return res.status(400).json({
                error: "Validation failed",
                details: {
                    sort: "is not a supported sort option"
                }
            });
        }

        let sql = "SELECT * FROM countries WHERE 1=1";
        const params = [];

        if (region) {
            sql += " AND region = ?";
            params.push(region);
        }

        if (currency) {
            sql += " AND currency_code = ?";
            params.push(currency);
        }

        if (sort) {
            sql += ` ORDER BY ${SORT_OPTIONS[sort]}`;
        }

        const [countries] = await db.execute(sql, params);
        res.json(countries);
    } catch (error) {
        sendError(res, error);
    }
};

exports.getCountry = async (req, res) => {
    try {
        const [countries] = await db.execute(
            "SELECT * FROM countries WHERE LOWER(name) = LOWER(?) LIMIT 1",
            [req.params.name]
        );

        if (!countries.length) {
            return res.status(404).json({
                error: "Country not found"
            });
        }

        res.json(countries[0]);
    } catch (error) {
        sendError(res, error);
    }
};

exports.deleteCountry = async (req, res) => {
    try {
        const [result] = await db.execute(
            "DELETE FROM countries WHERE LOWER(name) = LOWER(?)",
            [req.params.name]
        );

        if (!result.affectedRows) {
            return res.status(404).json({
                error: "Country not found"
            });
        }

        res.json({
            message: "Country deleted successfully"
        });
    } catch (error) {
        sendError(res, error);
    }
};

exports.getImage = (req, res) => {
    if (!fs.existsSync(SUMMARY_IMAGE_PATH)) {
        return res.status(404).json({
            error: "Summary image not found"
        });
    }

    res.type("png");
    res.sendFile(SUMMARY_IMAGE_PATH);
};
