require("dotenv").config();

const mysql = require("mysql2/promise");
const { getDbConfig } = require("./config/db");

async function setupDatabase() {
    const config = getDbConfig();
    let connection;

    console.log("Database configuration:", {
        host: config.host,
        port: config.port,
        database: config.database,
        userConfigured: Boolean(config.user),
        passwordConfigured: Boolean(config.password)
    });

    try {
        connection = await mysql.createConnection({
            host: config.host,
            user: config.user,
            password: config.password,
            database: config.database,
            port: config.port,
            connectTimeout: config.connectTimeout
        });

        console.log("Database connection successful!");

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS countries (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                capital VARCHAR(255) NULL,
                region VARCHAR(100) NULL,
                population BIGINT NOT NULL,
                currency_code VARCHAR(10) NULL,
                exchange_rate DECIMAL(20, 6) NULL,
                estimated_gdp DECIMAL(30, 4) NULL,
                flag_url TEXT NULL,
                last_refreshed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY unique_country_name (name)
            )
        `);

        await connection.execute(`
            ALTER TABLE countries
                MODIFY capital VARCHAR(255) NULL,
                MODIFY region VARCHAR(100) NULL,
                MODIFY currency_code VARCHAR(10) NULL,
                MODIFY exchange_rate DECIMAL(20, 6) NULL,
                MODIFY estimated_gdp DECIMAL(30, 4) NULL,
                MODIFY flag_url TEXT NULL
        `);

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS app_status (
                id INT PRIMARY KEY,
                last_refreshed_at TIMESTAMP NULL
            )
        `);

        await connection.execute(`
            INSERT IGNORE INTO app_status (id, last_refreshed_at)
            VALUES (1, NULL)
        `);

        console.log("Database tables created successfully!");
    } finally {
        if (connection) {
            await connection.end();
        }
    }
}

setupDatabase()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error("Database setup failed:", {
            code: error.code,
            message: error.code === "DB_CONFIG_MISSING"
                ? error.message
                : error.message
        });
        process.exit(1);
    });
