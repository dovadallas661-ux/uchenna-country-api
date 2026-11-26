const test = require("node:test");
const assert = require("node:assert/strict");
const axios = require("axios");

const {
    COUNTRIES_URL,
    EXCHANGE_RATES_URL,
    buildCountryRecords,
    validateCountryRecords,
    fetchExternalData
} = require("../services/countryService");

test("fetches the required v2 country endpoint and currency-specific exchange rates", async () => {
    const requests = [];
    const restore = axios.get;

    axios.get = async (url, options) => {
        requests.push({ url, options });
        if (url === COUNTRIES_URL) {
            return {
                data: [
                    { name: "Firstland", capital: "First City", region: "Region A", population: 100, flag: "https://example.test/first.svg", currencies: [{ code: "USD" }] },
                    { name: "Secondland", capital: "Second City", region: "Region B", population: 200, flag: "https://example.test/second.svg", currencies: [{ code: "EUR" }] },
                    { name: "Currencyless Island", population: 300, currencies: [] }
                ]
            };
        }

        const code = url.slice("https://open.er-api.com/v6/latest/".length);
        const usdPerUnit = code === "EUR" ? 1.2 : 1;
        return { data: { rates: { USD: usdPerUnit } } };
    };

    try {
        const { countries, rates } = await fetchExternalData();
        assert.equal(countries.length, 3);
        assert.equal(countries[0].name, "Firstland");
        assert.equal(countries[1].currencies[0].code, "EUR");
        assert.equal(rates.USD, 1);
        assert.equal(rates.EUR, 1 / 1.2);
        assert.equal(requests[0].url, COUNTRIES_URL);
        assert.deepEqual(requests.slice(1).map(({ url }) => url).sort(), [
            "https://open.er-api.com/v6/latest/EUR",
            "https://open.er-api.com/v6/latest/USD"
        ]);
        assert.equal(EXCHANGE_RATES_URL, "https://open.er-api.com/v6/latest/{CURRENCY_CODE}");
        assert.equal(requests.every(({ options }) => options.timeout === 20000), true);
    } finally {
        axios.get = restore;
    }
});

test("maps country fields and calculates estimated GDP using the supplied rate", () => {
    const [country] = buildCountryRecords([{
        name: "Exampleland",
        capital: "Sample City",
        region: "Example Region",
        population: 120000,
        currencies: [{ code: "USD" }],
        flag: "https://example.test/flag.svg"
    }], { USD: 1 }, () => 1000);

    assert.equal(country.name, "Exampleland");
    assert.equal(country.currency_code, "USD");
    assert.equal(country.exchange_rate, 1);
    assert.equal(country.estimated_gdp, 120000000);
    assert.equal(validateCountryRecords([country]), null);
});

test("keeps countries without a currency and without an exchange rate", () => {
    const [country] = buildCountryRecords([{
        name: "Currencyless Island",
        population: 1000,
        currencies: []
    }], {}, () => 1000);

    assert.equal(country.currency_code, null);
    assert.equal(country.exchange_rate, null);
    assert.equal(country.estimated_gdp, 0);
    assert.equal(validateCountryRecords([country]), null);
});

test("rejects malformed imported country records", () => {
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
