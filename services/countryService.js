const axios = require("axios");
const db = require("../config/db");

const COUNTRIES_URL = "https://api.restcountries.com/countries/v5";
const COUNTRIES_PAGE_SIZE = 100;
const EXCHANGE_RATES_URL = "https://open.er-api.com/v6/latest/{CURRENCY_CODE}";

function externalError() {
    const error = new Error("External data source unavailable");
    error.statusCode = 503;
    return error;
}

function apiKeyError() {
    const error = new Error("Missing required REST Countries configuration: REST_COUNTRIES_API_KEY");
    error.code = "REST_COUNTRIES_API_KEY_MISSING";
    error.statusCode = 500;
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
    if (currencies === undefined || currencies === null) {
        return { currency_code: null, allowNullCurrency: true };
    }
    if (!Array.isArray(currencies)) {
        return { currency_code: null, allowNullCurrency: false };
    }
    if (currencies.length === 0) {
        return { currency_code: null, allowNullCurrency: true };
    }

    const firstValid = currencies.find((currency) =>
        typeof currency?.code === "string" && /^[A-Za-z]{3}$/.test(currency.code.trim())
    );
    if (!firstValid) return { currency_code: null, allowNullCurrency: false };
    return { currency_code: firstValid.code.trim(), allowNullCurrency: true };
}

function mapCountry(country) {
    const capitals = Array.isArray(country?.capitals) ? country.capitals : [];
    const validCapitals = capitals.filter((capital) => typeof capital?.name === "string" && capital.name.trim());
    const capital = validCapitals.find((item) => item.attributes?.primary === true) || validCapitals[0];
    const flag = country?.flag || {};
    return {
        name: country?.names?.common,
        capital: capital?.name || null,
        region: country?.region ?? null,
        population: country?.population,
        currencies: country?.currencies,
        flag: typeof flag.url_svg === "string" && flag.url_svg.trim()
            ? flag.url_svg
            : typeof flag.url_png === "string" && flag.url_png.trim() ? flag.url_png : null
    };
}

function readCountryPage(response, expectedOffset) {
    const data = response?.data?.data;
    const objects = data?.objects;
    const meta = data?.meta;
    if (data?._demo || !Array.isArray(objects) || !objects.length || !meta ||
        !Number.isInteger(meta.total) || meta.total < 1 ||
        !Number.isInteger(meta.count) || meta.count !== objects.length ||
        !Number.isInteger(meta.limit) || meta.limit < 1 || meta.limit > COUNTRIES_PAGE_SIZE ||
        !Number.isInteger(meta.offset) || meta.offset !== expectedOffset ||
        typeof meta.more !== "boolean" || objects.length > meta.limit ||
        expectedOffset + objects.length > meta.total ||
        meta.more !== (expectedOffset + objects.length < meta.total)) {
        throw externalError();
    }
    return { objects, meta };
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

async function fetchExternalData() {
    const apiKey = process.env.REST_COUNTRIES_API_KEY;
    if (typeof apiKey !== "string" || !apiKey.trim()) throw apiKeyError();

    const countries = [];
    const seenPages = new Set();
    let offset = 0;
    let expectedTotal;
    while (true) {
        let response;
        try {
            response = await axios.get(COUNTRIES_URL, {
                timeout: 20000,
                headers: { Authorization: `Bearer ${apiKey.trim()}` },
                params: { limit: COUNTRIES_PAGE_SIZE, offset }
            });
        } catch (error) {
            console.error("External data request failed:", {
                service: "REST Countries",
                status: error.response?.status ?? null,
                code: error.code ?? null
            });
            throw externalError();
        }

        let page;
        try {
            page = readCountryPage(response, offset);
        } catch (error) {
            console.error("External data response invalid:", {
                service: "REST Countries",
                status: response?.status ?? null,
                code: "INVALID_OR_INCOMPLETE_RESPONSE"
            });
            throw externalError();
        }
        if (expectedTotal !== undefined && page.meta.total !== expectedTotal) throw externalError();
        expectedTotal = page.meta.total;
        const fingerprint = JSON.stringify(page.objects);
        if (seenPages.has(fingerprint)) throw externalError();
        seenPages.add(fingerprint);
        countries.push(...page.objects.map(mapCountry));
        offset += page.objects.length;
        if (!page.meta.more) break;
        if (offset >= expectedTotal || seenPages.size > expectedTotal) {
            throw externalError();
        }
    }
    if (countries.length !== expectedTotal) throw externalError();

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
    mapCountry,
    buildCountryRecords,
    validateCountryRecords,
    refreshCountries,
    saveCountries
};
