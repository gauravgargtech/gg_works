require("../config/config");
const fetch = require("node-fetch");
const URL = require("url").URL;

const BASE_URL = "https://api.coingecko.com/api/v3";

async function cgGet(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  console.log(`Fetching CoinGecko data from: ${url.toString()}`);
  console.log(`Using API Key: ${process.env.COINGECKO_KEY}`);

  const response = await fetch(url, {
    headers: {
      "x-cg-demo-api-key": process.env.COINGECKO_KEY,
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `CoinGecko API error ${response.status}: ${await response.text()}`,
    );
  }

  return response.json();
}

async function allCoins() {
  const coins = await cgGet("/coins/list", {
    include_platform: "true",
  });

  console.log(coins.length);

  const gg = coins.find((coin) => {
    if (coin.symbol.toLowerCase().includes("doge")) {
      console.log("Found Dogecoin:", coin);
    }
  });

  console.log("First 50 coins:");

  console.log(gg);
}

async function getCoinsWithMarketCapAtLeast(minMarketCap = 120_000_000) {
  const coins = [];
  let page = 1;

  while (true) {
    const batch = await cgGet("/coins/markets", {
      vs_currency: "usd",
      order: "volume_desc",
      per_page: "250",
      page: String(page),
      sparkline: "false",
    });

    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }

    // Results are ordered by descending market cap.
    for (const coin of batch) {
      if (coin.market_cap === null) continue;

      if (
        coin.market_cap !== null &&
        coin.market_cap >= minMarketCap &&
        coin.current_price !== null &&
        coin.current_price < 20 &&
        coin.total_volume >= 10_000_000
      ) {
        coins.push({
          id: coin.id,
          name: coin.name,
          symbol: coin.symbol.toUpperCase(),
          marketCapUsd: coin.market_cap,
          volume24hUsd: coin.total_volume,
          priceUsd: coin.current_price,
        });
      }
    }

    // Once the last coin on a page is below the threshold,
    // later pages will also be below it.
    const lastCoin = batch[batch.length - 1];

    if (
      batch.length < 250 ||
      (lastCoin.market_cap !== null && lastCoin.market_cap < minMarketCap)
    ) {
      break;
    }

    page++;
  }

  coins.sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));

  return coins;
}

async function getCoinMarketData(pair) {
  const normalizedPair = pair.toUpperCase().trim();

  // This example assumes USDT is the quote currency.
  if (!normalizedPair.endsWith("USDT")) {
    throw new Error("Expected a USDT pair, e.g. SUIUSDT");
  }

  const symbol = normalizedPair.slice(0, -4).toLowerCase();

  // Find possible matches. Symbols are not guaranteed to be unique.
  const matches = await cgGet("/coins/markets", {
    vs_currency: "usd",
    symbols: symbol,
    include_tokens: "all",
    per_page: "250",
    page: "1",
  });

  if (!Array.isArray(matches) || matches.length === 0) {
    throw new Error(`No CoinGecko match found for ${symbol}`);
  }

  console.log("\nPossible CoinGecko matches:");
  matches.forEach((coin, index) => {
    console.log(`${index + 1}. ${coin.name} (${coin.symbol}) | ID: ${coin.id}`);
  });

  if (matches.length > 1) {
    throw new Error(
      "Multiple coins found. Select the correct CoinGecko ID before proceeding.",
    );
  }

  const coin = matches[0];

  return {
    pair: normalizedPair,
    coinGeckoId: coin.id,
    name: coin.name,
    symbol: coin.symbol,
    priceUsd: coin.current_price,
    marketCapUsd: coin.market_cap,
    volume24hUsd: coin.total_volume,
    circulatingSupply: coin.circulating_supply,
    lastUpdated: coin.last_updated,
  };
}

module.exports = {
  getCoinMarketData,
  allCoins,
  getCoinsWithMarketCapAtLeast,
};
