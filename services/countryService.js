const axios = require("axios");
const db = require("../config/db");

const COUNTRIES_URL = "https://restcountries.com/v2/all?fields=name,capital,region,population,flag,currencies";
const EXCHANGE_RATES_URL = "https://open.er-api.com/v6/latest/{CURRENCY_CODE}";

function externalError() {
    const error = new Error("External data source unavailable");
    error.statusCode = 503;
    return error;
}

function validationError(details) {
    const error = new Error("Validation failed");
    error.statusCode = 400;
    error.details = details;
    return error;
}

function defaultMultiplier() {
    return Math.floor(Math.random() * 1001) + 1000;
}

function extractCurrency(currencies) {
    if (!Array.isArray(currencies) || currencies.length === 0) {
        return {
            currency_code: null,
            allowNullCurrency: true
        };
    }

    const code = currencies[0] && currencies[0].code;

    if (typeof code !== "string" || code.trim() === "") {
        return {
            currency_code: null,
            allowNullCurrency: false
        };
    }

    return {
        currency_code: code.trim(),
        allowNullCurrency: true
    };
}

function buildCountryRecords(countries, rates, randomMultiplier = defaultMultiplier) {
    return countries.map((country) => {
        const { currency_code: currencyCode, allowNullCurrency } = extractCurrency(country.currencies);
        const rawRate = currencyCode ? rates[currencyCode] : undefined;
        const exchangeRate = typeof rawRate === "number" && Number.isFinite(rawRate)
            ? rawRate
            : null;

        let estimatedGdp;

        if (!currencyCode) {
            estimatedGdp = allowNullCurrency ? 0 : null;
        } else if (exchangeRate === null || exchangeRate <= 0) {
            estimatedGdp = null;
        } else {
            const multiplier = randomMultiplier();
            estimatedGdp = (Number(country.population) * multiplier) / exchangeRate;
        }

        return {
            name: typeof country.name === "string" ? country.name.trim() : country.name,
            capital: country.capital || null,
            region: country.region || null,
            population: country.population,
            currency_code: currencyCode,
            exchange_rate: currencyCode && exchangeRate !== null && exchangeRate > 0
                ? exchangeRate
                : null,
            estimated_gdp: Number.isFinite(estimatedGdp) ? estimatedGdp : estimatedGdp === 0 ? 0 : null,
            flag_url: country.flag || null,
            allowNullCurrency
        };
    });
}

function validateCountryRecords(records) {
    for (const country of records) {
        const details = {};

        if (typeof country.name !== "string" || country.name.trim() === "") {
            details.name = "is required";
        }

        if (
            country.population === null ||
            country.population === undefined ||
            country.population === "" ||
            !Number.isFinite(Number(country.population)) ||
            Number(country.population) < 0
        ) {
            details.population = "is required";
        }

        if (!country.currency_code && !country.allowNullCurrency) {
            details.currency_code = "is required";
        }

        if (Object.keys(details).length) {
            return details;
        }
    }

    return null;
}

function isCountryList(data) {
    return Array.isArray(data);
}

async function fetchExternalData() {
    let countriesResponse;
    try {
        countriesResponse = await axios.get(COUNTRIES_URL, { timeout: 20000 });
    } catch (error) {
        console.error("External data request failed:", {
            service: "REST Countries",
            status: error.response?.status ?? null,
            code: error.code ?? null
        });
        throw externalError();
    }

    const countries = countriesResponse.data;
    const deprecatedApiResponse = countries &&
        !Array.isArray(countries) &&
        countries.success === false &&
        countries.data === null &&
        Array.isArray(countries.errors) &&
        countries.errors.some((item) => typeof item?.message === "string" && /deprecated/i.test(item.message));

    if (deprecatedApiResponse) {
        console.error("External data response rejected:", {
            service: "REST Countries",
            status: countriesResponse.status ?? null,
            code: "API_VERSION_DEPRECATED"
        });
        throw externalError();
    }

    if (!isCountryList(countries)) {
        console.error("External data response invalid:", {
            service: "REST Countries",
            status: countriesResponse.status ?? null,
            code: "INVALID_RESPONSE"
        });
        throw externalError();
    }

    const currencyCodes = [...new Set(countries.flatMap((country) => {
        const { currency_code: code } = extractCurrency(country.currencies);
        return code ? [code] : [];
    }))];

    let rates;
    try {
        const rateResponses = await Promise.all(currencyCodes.map(async (code) => {
            let response;
            try {
                response = await axios.get(
                    EXCHANGE_RATES_URL.replace("{CURRENCY_CODE}", encodeURIComponent(code)),
                    { timeout: 20000 }
                );
            } catch (error) {
                console.error("External data request failed:", {
                    service: "ExchangeRate API",
                    status: error.response?.status ?? null,
                    code: error.code ?? null,
                    currency_code: code
                });
                throw externalError();
            }

            const usdPerCurrency = response.data && response.data.rates && response.data.rates.USD;
            if (typeof usdPerCurrency !== "number" || !Number.isFinite(usdPerCurrency) || usdPerCurrency <= 0) {
                console.error("External data response invalid:", {
                    service: "ExchangeRate API",
                    status: response.status ?? null,
                    code: response.data?.["error-type"] ?? "INVALID_RESPONSE",
                    currency_code: code
                });
                throw externalError();
            }

            return response;
        }));

        rates = {};
        rateResponses.forEach((response, index) => {
            const usdPerCurrency = response.data && response.data.rates && response.data.rates.USD;
            // Store the same currency-per-USD quote used by the existing model.
            rates[currencyCodes[index]] = 1 / usdPerCurrency;
        });
    } catch (error) {
        throw externalError();
    }

    return { countries, rates };
}

async function refreshCountries() {
    const { countries, rates } = await fetchExternalData();
    const processed = buildCountryRecords(countries, rates);
    const details = validateCountryRecords(processed);

    if (details) {
        throw validationError(details);
    }

    return processed.map(({ allowNullCurrency, ...country }) => country);
}

async function saveCountries(countries) {
    const details = validateCountryRecords(
        countries.map((country) => ({
            ...country,
            allowNullCurrency: country.currency_code == null
        }))
    );

    if (details) {
        throw validationError(details);
    }

    const connection = await db.getConnection();

    try {
        await connection.beginTransaction();

        for (const country of countries) {
            const [existing] = await connection.execute(
                "SELECT id FROM countries WHERE LOWER(name) = LOWER(?) LIMIT 1",
                [country.name]
            );

            const values = [
                country.name,
                country.capital,
                country.region,
                country.population,
                country.currency_code,
                country.exchange_rate,
                country.estimated_gdp,
                country.flag_url
            ];

            if (existing.length) {
                await connection.execute(
                    `
                    UPDATE countries
                    SET name = ?,
                        capital = ?,
                        region = ?,
                        population = ?,
                        currency_code = ?,
                        exchange_rate = ?,
                        estimated_gdp = ?,
                        flag_url = ?,
                        last_refreshed_at = NOW()
                    WHERE id = ?
                    `,
                    [...values, existing[0].id]
                );
            } else {
                try {
                    await connection.execute(
                        `
                        INSERT INTO countries (
                            name, capital, region, population,
                            currency_code, exchange_rate,
                            estimated_gdp, flag_url,
                            last_refreshed_at
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
                        `,
                        values
                    );
                } catch (error) {
                    if (error.code !== "ER_DUP_ENTRY") {
                        throw error;
                    }

                    await connection.execute(
                        `
                        UPDATE countries
                        SET name = ?,
                            capital = ?,
                            region = ?,
                            population = ?,
                            currency_code = ?,
                            exchange_rate = ?,
                            estimated_gdp = ?,
                            flag_url = ?,
                            last_refreshed_at = NOW()
                        WHERE LOWER(name) = LOWER(?)
                        `,
                        [...values, country.name]
                    );
                }
            }
        }

        await connection.execute(`
            UPDATE app_status
            SET last_refreshed_at = NOW()
            WHERE id = 1
        `);

        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

module.exports = {
    COUNTRIES_URL,
    EXCHANGE_RATES_URL,
    fetchExternalData,
    buildCountryRecords,
    validateCountryRecords,
    refreshCountries,
    saveCountries
};
