const mysql = require("mysql2/promise");
require("dotenv").config();

const REQUIRED_VARIABLES = [
    "DB_HOST",
    "DB_USER",
    "DB_PASSWORD",
    "DB_NAME",
    "DB_PORT"
];

function isEnabled(value) {
    return ["1", "true", "yes"].includes(String(value || "").trim().toLowerCase());
}

function getDbConfig() {
    const missing = REQUIRED_VARIABLES.filter((name) => {
        const value = process.env[name];
        return value === undefined || String(value).trim() === "";
    });

    if (missing.length) {
        const error = new Error(
            `Missing required database configuration: ${missing.join(", ")}`
        );
        error.code = "DB_CONFIG_MISSING";
        throw error;
    }

    const port = Number(process.env.DB_PORT);

    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        const error = new Error("Missing required database configuration: DB_PORT");
        error.code = "DB_CONFIG_MISSING";
        throw error;
    }

    const config = {
        host: process.env.DB_HOST.trim(),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port,
        waitForConnections: true,
        connectionLimit: 10,
        connectTimeout: 15000,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0
    };

    // Railway's MySQL TCP proxy does not require TLS by default. Enable it only
    // when the provider explicitly requires TLS for the supplied endpoint.
    if (isEnabled(process.env.DB_SSL)) {
        config.ssl = { rejectUnauthorized: true };
    }

    return config;
}

const pool = mysql.createPool(getDbConfig());

module.exports = pool;
module.exports.getDbConfig = getDbConfig;
