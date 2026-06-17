/**
 * Crypto Sentiment Analyser
 * Pulls free RSS news feeds → Llama 3B via Groq → sentiment score per coin
 *
 * Required env var:
 *   GROQ_API_KEY  – free at https://console.groq.com/
 *
 * No other API keys needed — news comes from public RSS feeds.
 */

require("../config/config");
const Parser = require("rss-parser");
const Groq = require("groq-sdk");

const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");

dayjs.extend(utc);
dayjs.extend(timezone);

// ─── Config ────────────────────────────────────────────────────────────────
const { insert, remove, findAndSort } = require("../adapters/mongo");
const { set } = require("../adapters/redis");
const { sendPushNotif } = require("../config/telegram_notify");

const GROQ_KEY = process.env.GROQ_API_KEY;

if (!GROQ_KEY) {
  console.error(
    "❌  Missing GROQ_API_KEY.\n" +
      "    Get a free key at https://console.groq.com/ then run:\n" +
      "    GROQ_API_KEY=your_key_here node index.mjs",
  );
  process.exit(1);
}

const groq = new Groq({ apiKey: GROQ_KEY });
const rss = new Parser({
  timeout: 10_000,
  headers: { "User-Agent": "Mozilla/5.0" },
});

const LLAMA_MODEL = "llama-3.1-8b-instant"; // swap to "llama-3.1-8b-instant" for smarter
const ARTICLES_PER_COIN = 8; // how many matching headlines to send the model
const DELAY_MS = 800; // pause between coins (ms)
const MAX_AGE_DAYS = 3; // only keep articles from the last N days

// ─── Free RSS feed sources ─────────────────────────────────────────────────

const RSS_FEEDS = [
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "CoinTelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
  { name: "The Block", url: "https://www.theblock.co/rss.xml" },
  { name: "CryptoSlate", url: "https://cryptoslate.com/feed/" },
  { name: "Bitcoin Mag", url: "https://bitcoinmagazine.com/.rss/full/" },
];

// ─── Coins & keyword mappings ──────────────────────────────────────────────

const coins = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "TRXUSDT",
  "TONUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "LTCUSDT",
  "BCHUSDT",
  "ATOMUSDT",
  "NEARUSDT",
  "FILUSDT",
  "ICPUSDT",
  "ETCUSDT",
  "APTUSDT",
  "ARBUSDT",
  "OPUSDT",
  "SUIUSDT",
  "SEIUSDT",
  "INJUSDT",
  "TAOUSDT",
  "IMXUSDT",
  "STXUSDT",
  "GRTUSDT",
  "AAVEUSDT",
  "SNXUSDT",
  "COMPUSDT",
  "LDOUSDT",
  "SUSHIUSDT",
  "DYDXUSDT",
  "UNIUSDT",
  "1INCHUSDT",
  "GMXUSDT",
  "RUNEUSDT",
  "FLUXUSDT",
  "JUPUSDT",
  "WIFUSDT",
  "AKTUSDT",
  "NMRUSDT",
  "MANAUSDT",
  "SANDUSDT",
  "GALAUSDT",
  "ENJUSDT",
  "ILVUSDT",
  "BLURUSDT",
  "BRETTUSDT",
  "MEWUSDT",
  "WLDUSDT",
  "PYTHUSDT",
  "JTOUSDT",
  "STRKUSDT",
  "TIAUSDT",
  "ONDOUSDT",
  "ZKUSDT",
  "ALTUSDT",
];

const COIN_KEYWORDS = {
  BTC: ["bitcoin", "btc", "bitcoin network", "digital gold"],
  ETH: [
    "ethereum",
    "eth",
    "ether",
    "eth network",
    "ethereum network",
    "ultrasound money",
  ],
  BNB: [
    "bnb",
    "binance coin",
    "binance smart chain",
    "bsc",
    "bnb chain",
    "binance chain",
  ],
  SOL: ["solana", "sol", "sol network", "solana ecosystem"],
  XRP: ["xrp", "ripple", "xrp ledger", "xrpl"],
  ADA: ["cardano", "ada", "cardano blockchain"],
  DOGE: ["dogecoin", "doge", "doge coin"],
  TRX: ["tron", "trx", "tron network"],
  TON: [
    "toncoin",
    "ton network",
    "telegram open network",
    "the open network",
    "ton blockchain",
  ],
  AVAX: ["avalanche", "avax", "avax network", "avalanche c-chain"],
  LINK: [
    "chainlink",
    "link",
    "link token",
    "oracle network",
    "chainlink oracle",
  ],
  LTC: ["litecoin", "ltc"],
  BCH: ["bitcoin cash", "bch"],
  ATOM: ["cosmos", "atom", "cosmos hub", "interchain"],
  NEAR: ["near protocol", "near", "near blockchain"],
  FIL: ["filecoin", "fil", "filecoin network"],
  ICP: ["internet computer", "icp", "dfinity", "icp network"],
  ETC: ["ethereum classic", "etc"],
  APT: ["aptos", "apt", "aptos blockchain"],
  ARB: ["arbitrum", "arb", "arbitrum one", "arbitrum network"],
  OP: ["optimism", "op", "optimism network", "op mainnet"],
  SUI: ["sui network", "sui", "sui coin"],
  SEI: ["sei network", "sei", "sei blockchain"],
  INJ: ["injective", "inj", "injective protocol"],
  TAO: ["bittensor", "tao", "tao coin", "ai subnet"],
  IMX: ["immutablex", "immutable x", "imx", "imx token"],
  STX: ["stacks", "stx", "bitcoin layer 2 stacks"],
  GRT: ["the graph", "grt", "graph protocol", "indexing protocol"],
  AAVE: ["aave", "aave protocol", "aave token", "decentralized lending"],
  SNX: ["synthetix", "snx", "synthetix protocol"],
  COMP: ["compound", "compound finance", "comp", "lending protocol"],
  LDO: ["lido", "lido dao", "ldo", "liquid staking"],
  SUSHI: ["sushiswap", "sushi", "sushi token"],
  DYDX: ["dydx", "dydx exchange", "derivatives dex"],
  UNI: ["uniswap", "uni", "uniswap protocol", "dex"],
  "1INCH": ["1inch", "1inch network", "dex aggregator"],
  GMX: ["gmx", "gmx protocol", "perp dex"],
  RUNE: ["thorchain", "rune", "cross-chain liquidity"],
  FLUX: ["flux network", "flux", "decentralized cloud"],
  JUP: ["jupiter", "jup", "jupiter exchange", "solana aggregator"],
  WIF: ["dogwifhat", "wif", "wif coin", "solana meme"],
  AKT: ["akash network", "akt", "decentralized cloud compute"],
  NMR: ["numeraire", "nmr", "numerai"],
  MANA: ["decentraland", "mana", "metaverse token"],
  SAND: ["sandbox", "the sandbox", "sand", "metaverse game"],
  GALA: ["gala games", "gala", "gaming token"],
  ENJ: ["enjin", "enj", "gaming nft"],
  ILV: ["illuvium", "ilv", "aaa game token"],
  BLUR: ["blur", "blur nft", "blur token", "nft marketplace"],
  BRETT: ["brett", "brett meme", "brett token", "base meme"],
  MEW: ["cat in a dogs world", "mew", "mew coin", "solana cat meme"],
  WLD: ["worldcoin", "wld", "world id", "proof of personhood"],
  PYTH: ["pyth", "pyth network", "oracle", "pyth oracle"],
  JTO: ["jito", "jto", "solana staking"],
  STRK: ["starknet", "strk", "zk rollup"],
  TIA: ["celestia", "tia", "modular blockchain"],
  ONDO: ["ondo finance", "ondo", "real world assets", "rwa"],
  ZK: ["zksync", "zk", "zk rollup", "zero knowledge"],
  ALT: ["altlayer", "alt", "restaking layer"],
};

// ─── Helpers ───────────────────────────────────────────────────────────────

const NAME_MAP = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  BNB: "BNB",
  SOL: "Solana",
  XRP: "XRP",
  ADA: "Cardano",
  DOGE: "Dogecoin",
  TRX: "TRON",
  TON: "Toncoin",
  AVAX: "Avalanche",
  LINK: "Chainlink",
  LTC: "Litecoin",
  BCH: "Bitcoin Cash",
  ATOM: "Cosmos",
  NEAR: "NEAR Protocol",
  FIL: "Filecoin",
  ICP: "Internet Computer",
  ETC: "Ethereum Classic",
  APT: "Aptos",
  ARB: "Arbitrum",
  OP: "Optimism",
  SUI: "Sui",
  SEI: "Sei",
  INJ: "Injective",
  TAO: "Bittensor",
  IMX: "ImmutableX",
  STX: "Stacks",
  GRT: "The Graph",
  AAVE: "Aave",
  SNX: "Synthetix",
  COMP: "Compound",
  LDO: "Lido DAO",
  SUSHI: "SushiSwap",
  DYDX: "dYdX",
  UNI: "Uniswap",
  "1INCH": "1inch",
  GMX: "GMX",
  RUNE: "THORChain",
  FLUX: "Flux",
  JUP: "Jupiter",
  WIF: "dogwifhat",
  AKT: "Akash Network",
  NMR: "Numeraire",
  MANA: "Decentraland",
  SAND: "The Sandbox",
  GALA: "Gala Games",
  ENJ: "Enjin Coin",
  ILV: "Illuvium",
  BLUR: "Blur",
  BRETT: "Brett",
  MEW: "cat in a dogs world",
  WLD: "Worldcoin",
  PYTH: "Pyth Network",
  JTO: "Jito",
  STRK: "Starknet",
  TIA: "Celestia",
  ONDO: "Ondo Finance",
  ZK: "ZKsync",
  ALT: "AltLayer",
};

function toCurrency(symbol) {
  return symbol.replace(/USDT$/, "");
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000);
}

// ─── RSS cache — fetch all feeds once, reuse for every coin ───────────────

let _feedCache = null;

async function getAllArticles() {
  if (_feedCache) return _feedCache;

  const cutoff = daysAgo(MAX_AGE_DAYS);
  const all = [];

  await Promise.allSettled(
    RSS_FEEDS.map(async ({ name, url }) => {
      try {
        const feed = await rss.parseURL(url);
        for (const item of feed.items) {
          const pubDate = item.pubDate ? new Date(item.pubDate) : null;
          if (pubDate && pubDate < cutoff) continue; // too old
          all.push({
            title: item.title?.trim() ?? "",
            description: (item.contentSnippet ?? item.content ?? "")
              .slice(0, 300)
              .trim(),
            url: item.link ?? "",
            published_at: item.pubDate ?? "",
            source: name,
          });
        }
      } catch (err) {
        // silently skip a failing feed so others still work
        process.stderr.write(`  ⚠  ${name}: ${err.message}\n`);
      }
    }),
  );

  _feedCache = all;
  console.log(
    `  📰  Loaded ${all.length} articles from ${RSS_FEEDS.length} feeds\n`,
  );
  return all;
}

/** Filter global article pool by coin keywords */
function filterForCoin(articles, currency) {
  const keywords = COIN_KEYWORDS[currency] ?? [currency.toLowerCase()];
  return articles
    .filter((a) => {
      const haystack = (a.title + " " + a.description).toLowerCase();
      return keywords.some((kw) => haystack.includes(kw));
    })
    .slice(0, ARTICLES_PER_COIN);
}

// ─── Llama sentiment call ─────────────────────────────────────────────────

async function analyseSentiment(symbol, currency, articles) {
  const coinName = NAME_MAP[currency] ?? currency;

  if (articles.length === 0) {
    return {
      score: null,
      direction: "neutral",
      summary: "No recent news found in feeds.",
      keyFactors: [],
    };
  }

  const articleList = articles
    .map(
      (a, i) =>
        `[${i + 1}] (${a.source}, ${a.published_at.slice(0, 16)}) ${a.title}` +
        (a.description ? `\n     ${a.description}` : ""),
    )
    .join("\n\n");

  const prompt = `
You are a senior crypto market analyst specializing in short-term (24h–7d) price impact analysis.

Your job is to evaluate how the following recent news affects ${coinName} (${symbol}).

NEWS (only last ${MAX_AGE_DAYS} days):
${articleList}

---

ANALYSIS RULES:

1. Focus only on PRICE IMPACT (not general news importance).
2. Ignore duplicate, vague, or unrelated news.
3. Weight news by market relevance:
   - High impact: regulation, ETF flows, hacks, listings, liquidity, macro events
   - Medium impact: partnerships, ecosystem updates, upgrades
   - Low impact: opinion, minor updates, social chatter
4. If news is conflicting, prioritize:
   - Market flows > fundamentals > sentiment > opinions
5. Assume short-term horizon (1–7 days).
6. Be conservative — avoid extreme scores unless clearly justified.

---

OUTPUT RULES:
- Return ONLY valid JSON (no markdown, no explanation).
- Do NOT include extra keys.
- Keep summary factual and non-hype.

FORMAT:

{
  "score": <integer 1-10>,
  "direction": "<positive|negative|neutral>",
  "summary": "<2-3 sentences on likely short-term price impact>",
  "keyFactors": ["<factor 1>", "<factor 2>", "<factor 3>"]
}

---

SCORING GUIDE:
- 1–3 = strong bearish pressure
- 4–6 = neutral / mixed / unclear
- 7–10 = strong bullish pressure

Be consistent across similar news sets.
`;

  const completion = await groq.chat.completions.create({
    model: LLAMA_MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 512,
    temperature: 0.3,
  });

  const raw = completion.choices[0].message.content.trim();
  const clean = raw.replace(/^```(?:json)?|```$/gm, "").trim();

  try {
    return JSON.parse(clean);
  } catch {
    return { score: null, direction: "unknown", summary: raw, keyFactors: [] };
  }
}

// ─── Display ───────────────────────────────────────────────────────────────

function scoreBar(score) {
  if (score === null) return "N/A    ";
  const n = Math.round(score);
  return "█".repeat(n) + "░".repeat(10 - n) + `  ${score}/10`;
}

const ICON = { positive: "🟢", negative: "🔴", neutral: "🟡", unknown: "⚪" };

function printResult(symbol, currency, articles, a) {
  const name = NAME_MAP[currency] ?? currency;
  const bar = "─".repeat(62);
  console.log(`\n${bar}`);
  console.log(`📊  ${symbol}  (${name})`);
  console.log(bar);
  console.log(`  Articles found : ${articles.length}`);
  console.log(
    `  Sentiment      : ${ICON[a.direction] ?? "⚪"} ${(a.direction ?? "unknown").toUpperCase()}`,
  );
  console.log(`  Impact score   : ${scoreBar(a.score)}`);
  console.log(`\n  Summary:\n  ${a.summary}`);
  if (a.keyFactors?.length) {
    console.log(`\n  Key factors:`);
    a.keyFactors.forEach((f) => console.log(`    • ${f}`));
  }
  if (articles.length) {
    console.log(`\n  Top headlines:`);
    articles.slice(0, 3).forEach((art, i) => {
      const t =
        art.title.length > 88 ? art.title.slice(0, 85) + "…" : art.title;
      console.log(`    ${i + 1}. [${art.source}] ${t}`);
    });
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function runSentiment() {
  console.log("🚀  Crypto Sentiment Analyser");
  console.log(`    Model  : ${LLAMA_MODEL}`);
  console.log(`    Coins  : ${coins.length}`);
  console.log(`    Window : last ${MAX_AGE_DAYS} days`);
  console.log(
    `    Source : free RSS (CoinDesk, CoinTelegraph, Decrypt, The Block, CryptoSlate, Bitcoin Mag)\n`,
  );

  // Pre-fetch all feeds once
  const allArticles = await getAllArticles();

  const results = [];
  const allFoundCoins = [];

  for (let i = 0; i < coins.length; i++) {
    const symbol = coins[i];
    const currency = toCurrency(symbol);

    process.stdout.write(
      `[${String(i + 1).padStart(2, "0")}/${coins.length}] ${symbol.padEnd(12)}`,
    );

    const articles = filterForCoin(allArticles, currency);
    process.stdout.write(`${String(articles.length).padStart(3)} articles → `);

    let analysis;
    try {
      analysis = await analyseSentiment(symbol, currency, articles);

      const existingScore = await findAndSort(
        "news_sentiment",
        { symbol: symbol },
        { unix: -1 },
        1,
      );

      let theScore = 0;
      if (existingScore?.[0]) {
        theScore = existingScore[0].score;
      }

      if (analysis?.score) {
        allFoundCoins.push(symbol);
      }
      if (analysis?.score && analysis.score != theScore) {
        await insert("news_sentiment", {
          symbol,
          currency,
          articles: articles.length,
          ...analysis,
          times: dayjs().tz("Australia/Brisbane").format("YYYY-MM-DD HH:mm:ss"),
          unix: dayjs().tz("Australia/Brisbane").unix(),
        });
      }

      if (analysis?.score && analysis.score > 7) {
        const isCC = await get(`news_sentiment_${symbol}`);
        if (!isCC) {
          await set(`news_sentiment_${symbol}`, "ok", 3600 * 24);
          await sendPushNotif(
            `News Alert 🚨:  ${symbol} is trending ${analysis.direction}, Got News!`,
          );
        }
      }

      //const score = analysis.score !== null ? `${analysis.score}/10` : " N/A";
      //process.stdout.write(`score ${score} (${analysis.direction})\n`);
      //printResult(symbol, currency, articles, analysis);

      if (allFoundCoins.length > 0) {
        await set("all_found_coins", JSON.stringify(allFoundCoins));
      }

      results.push({
        symbol,
        currency,
        articles: articles.length,
        ...analysis,
      });
    } catch (err) {
      process.stdout.write(`ERROR: ${err.message}\n`);
      results.push({
        symbol,
        currency,
        score: null,
        direction: "error",
        summary: err.message,
      });
    }

    if (i < coins.length - 1) await sleep(DELAY_MS);
  }

  // ── Leaderboard ─────────────────────────────────────────────────────────
  const eq = "═".repeat(62);
  console.log(`\n${eq}\n🏆  FINAL SENTIMENT LEADERBOARD\n${eq}`);

  const scored = results
    .filter((r) => r.score !== null)
    .sort((a, b) => b.score - a.score);

  console.log("\n  TOP 5 BULLISH 🟢");
  scored
    .slice(0, 5)
    .forEach((r, i) =>
      console.log(`    ${i + 1}. ${r.symbol.padEnd(13)} ${scoreBar(r.score)}`),
    );

  console.log("\n  TOP 5 BEARISH 🔴");
  scored
    .slice(-5)
    .reverse()
    .forEach((r, i) =>
      console.log(`    ${i + 1}. ${r.symbol.padEnd(13)} ${scoreBar(r.score)}`),
    );

  const avg = scored.reduce((s, r) => s + r.score, 0) / (scored.length || 1);
  console.log(`\n  Market avg score : ${avg.toFixed(1)}/10`);
  console.log("\n✅  Done.\n");
}

module.exports = runSentiment;
