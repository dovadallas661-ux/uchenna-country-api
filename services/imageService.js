const sharp = require("sharp");
const db = require("../config/db");
const fs = require("fs");
const path = require("path");

const CACHE_DIRECTORY = path.join(__dirname, "../cache");
const SUMMARY_IMAGE_PATH = path.join(CACHE_DIRECTORY, "summary.png");

function escapeXml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function formatTimestamp(value) {
    if (!value) {
        return "N/A";
    }

    const date = value instanceof Date ? value : new Date(value);

    if (Number.isNaN(date.getTime())) {
        return escapeXml(value);
    }

    return date.toISOString();
}

function formatGdp(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return "N/A";
    }

    return number.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function buildSummarySvg({ total, topCountries, lastRefreshedAt }) {
    const list = topCountries.map((country, index) => `
        <text x="40" y="${190 + index * 55}" font-size="22" font-family="Arial, Helvetica, sans-serif">
            ${index + 1}. ${escapeXml(country.name)}: ${escapeXml(formatGdp(country.estimated_gdp))}
        </text>
    `).join("");

    return `
    <svg width="1100" height="550" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#101827"/>
      <text x="40" y="65" fill="white" font-size="32" font-family="Arial, Helvetica, sans-serif">
        Country Currency Summary
      </text>
      <text x="40" y="120" fill="white" font-size="24" font-family="Arial, Helvetica, sans-serif">
        Total countries: ${escapeXml(total)}
      </text>
      <text x="40" y="160" fill="white" font-size="22" font-family="Arial, Helvetica, sans-serif">
        Top 5 by estimated GDP
      </text>
      <g fill="white">
        ${list}
      </g>
      <text x="40" y="500" fill="white" font-size="17" font-family="Arial, Helvetica, sans-serif">
        Last refresh: ${formatTimestamp(lastRefreshedAt)}
      </text>
    </svg>`;
}

async function renderSummaryPng(summary) {
    return sharp(Buffer.from(buildSummarySvg(summary)))
        .png()
        .toBuffer();
}

async function generateSummaryImage() {
    const [[{ total }]] = await db.execute(
        "SELECT COUNT(*) AS total FROM countries"
    );

    const [topCountries] = await db.execute(`
        SELECT name, estimated_gdp
        FROM countries
        WHERE estimated_gdp IS NOT NULL
        ORDER BY estimated_gdp DESC
        LIMIT 5
    `);

    const [statusRows] = await db.execute(
        "SELECT last_refreshed_at FROM app_status WHERE id = 1"
    );

    const png = await renderSummaryPng({
        total,
        topCountries,
        lastRefreshedAt: statusRows[0] ? statusRows[0].last_refreshed_at : null
    });

    fs.mkdirSync(CACHE_DIRECTORY, { recursive: true });
    await fs.promises.writeFile(SUMMARY_IMAGE_PATH, png);
}

module.exports = generateSummaryImage;
module.exports.SUMMARY_IMAGE_PATH = SUMMARY_IMAGE_PATH;
module.exports.buildSummarySvg = buildSummarySvg;
module.exports.renderSummaryPng = renderSummaryPng;
