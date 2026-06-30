const Groq = require("groq-sdk");
const { GROQ, CURRENCIES } = require("../config");

const groq = new Groq({ apiKey: GROQ.apiKey });

const SYSTEM_PROMPT = `
You are a forex fundamental news sentiment classifier for currency pairs.

You will be given:
- A currency pair (e.g., EURUSD, GBPJPY)
- A list of recent news headlines related to that pair or its currencies

Your task is to evaluate how these headlines collectively impact the FUNDAMENTAL outlook of the BASE currency (first currency in the pair) relative to the QUOTE currency (second currency in the pair).

You must focus on FUNDAMENTAL macroeconomic impact, not short-term price action.

---

OUTPUT RULES:
Respond with ONLY a single valid JSON object.
No markdown, no explanation, no extra text.

The JSON must follow this exact structure:

{
  "sentiment": <number from -1 to 1>,
  "confidence": <number from 0 to 1>,
  "key_drivers": [
    {
      "factor": "<short label>",
      "direction": "bullish" | "bearish",
      "weight": "high" | "medium" | "low",
      "impact_score": <number from 0 to 1>
    }
  ],
  "market_regime_bias": "risk_on" | "risk_off" | "neutral",
  "conflicting_signals": "<one sentence describing contradictions or null>",
  "reasoning": "<2–3 sentences summarizing net effect, key drivers, and conflicts>",
  "time_horizon": "short" | "medium" | "long",
  "stale_or_irrelevant": <true | false>,
  "action_bias": "long" | "short" | "avoid"
}

---

CORE RULES:

1. BASE vs QUOTE CURRENCY:
- "bullish" ALWAYS means positive for the BASE currency (first in pair)
- "bearish" ALWAYS means negative for the BASE currency

Example:
EURUSD bullish = EUR strength OR USD weakness

---

2. SENTIMENT SCORING:
- -1 = strongly bearish for base currency
- 0 = neutral or mixed/no strong edge
- +1 = strongly bullish for base currency
- Sentiment MUST be weighted based on key_drivers and their importance

---

3. CONFIDENCE RULES:
- 0.0 → no meaningful macro signal or irrelevant headlines
- 0.3–0.5 → weak or mixed signals
- 0.6–0.8 → clear macro bias
- 0.9–1.0 → strong, multi-confirmed macro theme

If headlines are vague or generic, confidence must be low even if sentiment is assigned.

---

4. KEY DRIVERS RULES:
- Extract DISTINCT macroeconomic factors only (no duplicates)
- Merge similar ideas (e.g., "rate hike expectations" + "hawkish Fed" → one driver)
- Use 1–5 drivers maximum
- Each driver must reflect real macro themes such as:
  - Interest rate expectations / central bank policy
  - Inflation (CPI, PCE)
  - Employment data (NFP, unemployment)
  - GDP / growth outlook
  - Yield differentials
  - Risk sentiment (risk-on / risk-off)
  - USD strength / DXY impact
  - Commodity prices (oil, metals)
  - China economic impact (AUD/NZD sensitivity)
  - Geopolitical risk / safe haven flows
  - Trade balance / exports impact
  - Central bank forward guidance tone (hawkish/dovish)

---

5. IMPACT SCORING:
- impact_score = 0.0 to 1.0
- 1.0 = extremely high impact macro driver (e.g., Fed rate decision)
- 0.5 = moderate macro factor (e.g., mixed CPI)
- 0.1–0.3 = weak or secondary influence

---

6. MARKET REGIME:
- risk_on → equities up, USD weaker, AUD/NZD stronger
- risk_off → safe havens stronger (USD, JPY, CHF)
- neutral → no clear global risk tone

Infer from headlines when possible.

---

7. CONFLICT HANDLING:
- If strong bullish and bearish drivers both exist, explain contradiction clearly
- If contradictions cancel out, sentiment must move toward 0

---

8. STALENESS:
Set stale_or_irrelevant = true if:
- headlines are outdated
- headlines are not macro relevant
- duplicate or noise content dominates

---

9. ACTION BIAS:
- long → bullish bias on base currency
- short → bearish bias on base currency
- avoid → unclear, low confidence, or conflicting signals

---

10. NO HALLUCINATION RULE:
- Do NOT assume macro events not present in headlines
- If uncertain, reduce confidence instead of guessing
- Only infer widely known macro relationships when strongly implied

---

11. TIME HORIZON:
- short → intraday / 1–3 days (news shocks, sentiment shifts)
- medium → 1–4 weeks (data trends, positioning shifts)
- long → structural macro shifts (policy cycles, sustained inflation/growth changes)

---

12. EMPTY INPUT CASE:
If headlines list is empty or irrelevant:
Return:
- sentiment = 0
- confidence = 0
- key_drivers = []
- conflicting_signals = null
- reasoning = explain lack of usable signal
- stale_or_irrelevant = true
- action_bias = "avoid"

`;

/** Clamp a number into [min, max], default to fallback if not a finite number. */
function clamp(n, min, max, fallback = 0) {
  if (typeof n !== "number" || isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const VALID_DIRECTIONS = new Set(["bullish", "bearish"]);
const VALID_WEIGHTS = new Set(["high", "medium", "low"]);
const VALID_HORIZONS = new Set(["short", "medium", "long"]);

function sanitizeKeyDrivers(drivers) {
  if (!Array.isArray(drivers)) return [];
  return drivers
    .filter(
      (d) =>
        d &&
        typeof d.factor === "string" &&
        VALID_DIRECTIONS.has(d.direction) &&
        VALID_WEIGHTS.has(d.weight),
    )
    .slice(0, 5) // hard cap, in case the model ignores the 1-5 guidance
    .map((d) => ({
      factor: d.factor.slice(0, 80),
      direction: d.direction,
      weight: d.weight,
    }));
}

function parseSentimentResponse(rawText) {
  let text = (rawText || "").trim();
  // Strip markdown fences if the model added them despite instructions
  text = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "");

  try {
    const parsed = JSON.parse(text);

    const keyDrivers = sanitizeKeyDrivers(parsed.key_drivers);

    return {
      sentiment: clamp(parsed.sentiment, -1, 1, 0),
      confidence: clamp(parsed.confidence, 0, 1, 0),
      keyDrivers,
      conflictingSignals:
        typeof parsed.conflicting_signals === "string"
          ? parsed.conflicting_signals.slice(0, 280)
          : null,
      reasoning:
        typeof parsed.reasoning === "string"
          ? parsed.reasoning.slice(0, 500)
          : "",
      timeHorizon: VALID_HORIZONS.has(parsed.time_horizon)
        ? parsed.time_horizon
        : "unknown",
      staleOrIrrelevant: parsed.stale_or_irrelevant === true,
    };
  } catch (err) {
    console.warn(
      "[sentiment] failed to parse LLM JSON, falling back to neutral:",
      text.slice(0, 120),
    );
    return {
      sentiment: 0,
      confidence: 0,
      keyDrivers: [],
      conflictingSignals: null,
      reasoning: "parse_error",
      timeHorizon: "unknown",
      staleOrIrrelevant: false,
    };
  }
}

/** Score sentiment for ONE currency given its tagged headlines. */
async function scoreCurrencySentiment(currency, headlines) {
  if (!headlines || headlines.length === 0) {
    return { currency, sentiment: 0, confidence: 0, reasoning: "no_headlines" };
  }

  // Cap how many headlines we send — keeps token usage sane and avoids
  // diluting signal with low-relevance older items
  const sample = headlines
    .slice(0, 12)
    .map((h) => `- ${h.title}`)
    .join("\n");

  try {
    const completion = await groq.chat.completions.create({
      model: GROQ.model,
      temperature: 0.1, // low temp — we want consistent scoring, not creativity
      max_tokens: 800,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Currency: ${currency}\nHeadlines:\n${sample}`,
        },
      ],
    });

    const rawText = completion.choices?.[0]?.message?.content || "";
    const result = parseSentimentResponse(rawText);
    return { currency, ...result };
  } catch (err) {
    console.error(`[sentiment] Groq call failed for ${currency}:`, err.message);
    return { currency, sentiment: 0, confidence: 0, reasoning: "llm_error" };
  }
}

/**
 * Score every currency's tagged headlines. Run sequentially with a small
 * delay rather than Promise.all — keeps you comfortably inside Groq's free
 * rate limits rather than bursting 8 requests at once.
 */
async function scoreAllCurrencies(byCurrency) {
  const results = {};
  for (const currency of CURRENCIES) {
    const r = await scoreCurrencySentiment(
      currency,
      byCurrency[currency] || [],
    );
    // confidence-weighted score — low-confidence readings pull toward 0
    // rather than contributing full-strength noise to the composite
    results[currency] = r.sentiment * r.confidence;
    results[`${currency}_detail`] = r;
    await new Promise((res) => setTimeout(res, 250));
  }
  return results;
}

module.exports = {
  scoreCurrencySentiment,
  scoreAllCurrencies,
  parseSentimentResponse,
};
