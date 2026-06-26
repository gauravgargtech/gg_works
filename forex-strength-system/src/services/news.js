const Parser = require("rss-parser");
const { NEWS_FEEDS, CURRENCY_KEYWORDS, CURRENCIES } = require("../config");

const parser = new Parser({
  timeout: 10_000,
  headers: { "User-Agent": "Mozilla/5.0" },
});

/** Pull and merge all configured RSS feeds. Failures on one feed don't kill the run. */
async function fetchAllHeadlines() {
  const items = [];
  for (const feed of NEWS_FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      for (const item of parsed.items || []) {
        items.push({
          source: feed.name,
          title: item.title || "",
          summary: (item.contentSnippet || item.content || "").slice(0, 300),
          link: item.link,
          publishedAt: item.pubDate || item.isoDate || null,
        });
      }
    } catch (err) {
      console.error(`[news] failed to fetch ${feed.name}:`, err.message);
    }
  }
  return items;
}

/**
 * Tag each headline to whichever currencies it mentions, based on simple
 * keyword matching. A headline can map to multiple currencies (e.g. an
 * "EUR/CHF" story tags both EUR and CHF).
 */
function tagHeadlinesByCurrency(headlines) {
  const byCurrency = {};
  for (const c of CURRENCIES) byCurrency[c] = [];

  for (const item of headlines) {
    const text = `${item.title} ${item.summary}`.toLowerCase();
    for (const c of CURRENCIES) {
      const keywords = CURRENCY_KEYWORDS[c] || [];
      if (keywords.some((kw) => text.includes(kw))) {
        byCurrency[c].push(item);
      }
    }
  }
  return byCurrency;
}

/** Convenience: fetch + tag in one call. */
async function getTaggedHeadlines() {
  const headlines = await fetchAllHeadlines();
  return { headlines, byCurrency: tagHeadlinesByCurrency(headlines) };
}

module.exports = { fetchAllHeadlines, tagHeadlinesByCurrency, getTaggedHeadlines };
