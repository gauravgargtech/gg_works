const Groq = require("groq-sdk");
const { GROQ, CURRENCIES } = require("../config");

const groq = new Groq({ apiKey: GROQ.apiKey });

const SYSTEM_PROMPT = `You are a forex news sentiment classifier. You will be given a currency
code and a list of recent headlines that mention it. Score how the headlines, taken together,
suggest the currency's value is likely to move FUNDAMENTALLY (not just today's price action).

Respond with ONLY a single JSON object, no markdown fences, no preamble, no explanation outside
the JSON, in exactly this shape:
{"sentiment": <number from -1 to 1>, "confidence": <number from 0 to 1>, "reasoning": "<one short sentence>"}

sentiment: -1 = strongly bearish for this currency, 0 = neutral/mixed, 1 = strongly bullish.
confidence: how much signal these headlines actually contain (0 if headlines are vague/irrelevant).
If the headlines list is empty or contains nothing currency-relevant, return sentiment 0, confidence 0.`;

/** Clamp a number into [min, max], default to fallback if not a finite number. */
function clamp(n, min, max, fallback = 0) {
  if (typeof n !== "number" || isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Parse a Groq completion's text content into a validated sentiment object.
 * Never trusts the LLM blindly — strips stray markdown fences, validates
 * schema, clamps out-of-range values, and falls back to neutral on failure.
 */
function parseSentimentResponse(rawText) {
  let text = (rawText || "").trim();
  // Strip markdown fences if the model added them despite instructions
  text = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");

  try {
    const parsed = JSON.parse(text);
    return {
      sentiment: clamp(parsed.sentiment, -1, 1, 0),
      confidence: clamp(parsed.confidence, 0, 1, 0),
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 280) : "",
    };
  } catch (err) {
    console.warn("[sentiment] failed to parse LLM JSON, falling back to neutral:", text.slice(0, 120));
    return { sentiment: 0, confidence: 0, reasoning: "parse_error" };
  }
}

/** Score sentiment for ONE currency given its tagged headlines. */
async function scoreCurrencySentiment(currency, headlines) {
  if (!headlines || headlines.length === 0) {
    return { currency, sentiment: 0, confidence: 0, reasoning: "no_headlines" };
  }

  // Cap how many headlines we send — keeps token usage sane and avoids
  // diluting signal with low-relevance older items
  const sample = headlines.slice(0, 12).map((h) => `- ${h.title}`).join("\n");

  try {
    const completion = await groq.chat.completions.create({
      model: GROQ.model,
      temperature: 0.1, // low temp — we want consistent scoring, not creativity
      max_tokens: 200,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Currency: ${currency}\nHeadlines:\n${sample}` },
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
    const r = await scoreCurrencySentiment(currency, byCurrency[currency] || []);
    // confidence-weighted score — low-confidence readings pull toward 0
    // rather than contributing full-strength noise to the composite
    results[currency] = r.sentiment * r.confidence;
    results[`${currency}_detail`] = r;
    await new Promise((res) => setTimeout(res, 250));
  }
  return results;
}

module.exports = { scoreCurrencySentiment, scoreAllCurrencies, parseSentimentResponse };
