const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

const {
    COUNTRIES_URL,
    EXCHANGE_RATES_URL,
    mapCountry,
    buildCountryRecords,
    validateCountryRecords,
    fetchExternalData
} = require("../services/countryService");

async function withAxiosMock(mockGet, run, apiKey = "test-api-key") {
    const originalGet = axios.get;
    const originalApiKey = process.env.REST_COUNTRIES_API_KEY;
    axios.get = mockGet;
    if (apiKey === null) delete process.env.REST_COUNTRIES_API_KEY;
    else process.env.REST_COUNTRIES_API_KEY = apiKey;
    try {
        await run();
    } finally {
        axios.get = originalGet;
        if (originalApiKey === undefined) delete process.env.REST_COUNTRIES_API_KEY;
        else process.env.REST_COUNTRIES_API_KEY = originalApiKey;
    }
}

function countryPage(objects, { total = objects.length, count = objects.length, limit = 100, offset = 0, more = false } = {}) {
    return { data: { data: { objects, meta: { total, count, limit, offset, more } } } };
}

function rawCountry(name, overrides = {}) {
    return {
        names: { common: name },
        capitals: [{ name: `${name} City`, attributes: { primary: true } }],
        region: "Test Region",
        population: 100,
        currencies: [{ code: "USD", name: "US dollar", symbol: "$" }],
        flag: { url_svg: `https://example.test/${name}.svg` },
        ...overrides
    };
}

test("fetches v5 pages with Bearer authentication and exchange rates", async () => {
    const requests = [];
    await withAxiosMock(async (url, options) => {
        requests.push({ url, options });
        if (url === COUNTRIES_URL) {
            if (options.params.offset === 0) {
                return countryPage([
                    rawCountry("Firstland"),
                    rawCountry("Secondland", { currencies: [{ code: "EUR", name: "Euro", symbol: "€" }] })
                ], { total: 3, more: true });
            }
            return countryPage([
                rawCountry("Currencyless Island", { currencies: [] })
            ], { total: 3, offset: 2 });
        }
        const code = url.slice("https://open.er-api.com/v6/latest/".length);
        return { data: { rates: { USD: code === "EUR" ? 1.2 : 1 } } };
    }, async () => {
        const { countries, rates } = await fetchExternalData();

        assert.equal(COUNTRIES_URL, "https://api.restcountries.com/countries/v5");
        const countryRequests = requests.filter(({ url }) => url === COUNTRIES_URL);
        assert.deepEqual(countryRequests.map(({ options }) => options.params), [
            { limit: 100, offset: 0 },
            { limit: 100, offset: 2 }
        ]);
        assert.equal(countryRequests[0].options.headers.Authorization, "Bearer test-api-key");
        assert.equal(countryRequests[0].options.timeout, 20000);
        assert.deepEqual(countries.map(({ name }) => name), ["Firstland", "Secondland", "Currencyless Island"]);
        assert.deepEqual(requests.filter(({ url }) => url.startsWith("https://open.er-api.com/"))
            .map(({ url }) => url).sort(), [
            "https://open.er-api.com/v6/latest/EUR",
            "https://open.er-api.com/v6/latest/USD"
        ]);
        assert.equal(rates.USD, 1);
        assert.equal(rates.EUR, 1 / 1.2);
        assert.equal(EXCHANGE_RATES_URL, "https://open.er-api.com/v6/latest/{CURRENCY_CODE}");
    });
});

test("rejects a missing API key without making an HTTP request", async () => {
    let requested = false;
    await withAxiosMock(async () => { requested = true; }, async () => {
        await assert.rejects(fetchExternalData(), (error) =>
            error.code === "REST_COUNTRIES_API_KEY_MISSING" && error.statusCode === 500);
        assert.equal(requested, false);
    }, null);
});

test("maps v5 name, primary capital, region, population, currency array, and flag", () => {
    const mapped = mapCountry(rawCountry("Exampleland", {
        capitals: [
            { name: "Administrative City", attributes: { administrative: true } },
            { name: "Primary City", attributes: { primary: true } }
        ],
        currencies: [{ code: "AFN", name: "Afghan afghani", symbol: "" }]
    }));
    assert.equal(mapped.name, "Exampleland");
    assert.equal(mapped.capital, "Primary City");
    assert.equal(mapped.region, "Test Region");
    assert.equal(mapped.population, 100);
    assert.deepEqual(mapped.currencies, [{ code: "AFN", name: "Afghan afghani", symbol: "" }]);
    assert.equal(mapped.flag, "https://example.test/Exampleland.svg");
});

test("uses first valid capital and PNG flag fallback", () => {
    const mapped = mapCountry(rawCountry("Exampleland", {
        capitals: [{ name: "First City" }, { name: "Second City" }],
        flag: { url_png: "https://example.test/flag.png" }
    }));
    assert.equal(mapped.capital, "First City");
    assert.equal(mapped.flag, "https://example.test/flag.png");
});

test("extracts the first valid three-letter currency from an array", () => {
    const [record] = buildCountryRecords([{
        name: "Exampleland",
        population: 100,
        currencies: [null, { code: "USDX" }, { code: " AFN ", name: "Afghan afghani" }, { code: "EUR" }]
    }], { AFN: 2, EUR: 1.2 }, () => 1000);
    assert.equal(record.currency_code, "AFN");
    assert.equal(record.exchange_rate, 2);
    assert.equal(validateCountryRecords([record]), null);
});

test("accepts empty and missing currencies but rejects malformed currency data", () => {
    const [empty, missing, malformedEntries, malformedShape] = buildCountryRecords([
        { name: "Empty Currency", population: 1, currencies: [] },
        { name: "Missing Currency", population: 1 },
        { name: "Malformed Entries", population: 1, currencies: [null, { name: "No code" }, { code: "USDX" }] },
        { name: "Malformed Shape", population: 1, currencies: { USD: {} } }
    ], {}, () => 1000);
    assert.equal(empty.currency_code, null);
    assert.equal(missing.currency_code, null);
    assert.equal(validateCountryRecords([empty]), null);
    assert.equal(validateCountryRecords([missing]), null);
    assert.deepEqual(validateCountryRecords([malformedEntries]), { currency_code: "is required" });
    assert.deepEqual(validateCountryRecords([malformedShape]), { currency_code: "is required" });
});

test("calculates estimated GDP with the supplied rate and multiplier", () => {
    const [record] = buildCountryRecords([{
        name: "Exampleland",
        population: 120000,
        currencies: [{ code: "USD" }]
    }], { USD: 2 }, () => 1000);
    assert.equal(record.exchange_rate, 2);
    assert.equal(record.estimated_gdp, 60000000);
    assert.equal(validateCountryRecords([record]), null);
});

test("handles countries without currencies and preserves zero GDP", () => {
    const [record] = buildCountryRecords([{
        name: "Currencyless Island",
        population: 1000,
        currencies: []
    }], {}, () => 1000);
    assert.equal(record.currency_code, null);
    assert.equal(record.exchange_rate, null);
    assert.equal(record.estimated_gdp, 0);
    assert.equal(validateCountryRecords([record]), null);
});

test("rejects malformed and incomplete country API responses", async (t) => {
    const invalidResponses = [
        ["missing response envelope", { data: {} }],
        ["missing pagination metadata", { data: { data: { objects: [rawCountry("One")] } } }],
        ["count does not match records", countryPage([rawCountry("One")], { count: 2 })],
        ["meta.more claims records are missing but is false", countryPage([rawCountry("One")], { total: 2 })],
        ["demo sample response", { data: { data: { ...countryPage([rawCountry("Demo")]).data.data, _demo: true } } }]
    ];
    for (const [name, response] of invalidResponses) {
        await t.test(name, async () => {
            await withAxiosMock(async () => response, async () => {
                await assert.rejects(fetchExternalData(), (error) => error.statusCode === 503);
            });
        });
    }
});

test("rejects invalid exchange-rate responses", async () => {
    await withAxiosMock(async (url) => {
        if (url === COUNTRIES_URL) return countryPage([rawCountry("Exampleland")]);
        return { data: { rates: { USD: 0 } } };
    }, async () => {
        await assert.rejects(fetchExternalData(), (error) => error.statusCode === 503);
    });
});

test("validates required name, population, and malformed currency fields", () => {
    assert.deepEqual(validateCountryRecords([{
        name: " ",
        population: -1,
        currency_code: null,
        allowNullCurrency: false
    }]), {
        name: "is required",
        population: "is required",
        currency_code: "is required"
    });
});
