require("../config/config");

const RabbitMQ = require("../adapters/rabbitmq");

const dayjs = require("dayjs");

const utc = require("dayjs/plugin/utc.js");
const timezone = require("dayjs/plugin/timezone.js");
const { fetchCandles } = require("../exhanges/bybit_public");

const { computeTSI } = require("../indicators/tsi");
const timeframe = 15;

dayjs.extend(utc);
dayjs.extend(timezone);

const powerKama = require("../indicators/pkama_old");

const { sendPushNotif } = require("../config/telegram_notify");
const _ = require("lodash");

const sleep = async (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));

// ─── Main ─────────────────────────────────────────────────────
async function capitalCrypto() {
  const rabbit = RabbitMQ.getInstance();

  console.log("--Running Capital crypto");

  const allSignals = [];

  for (const [bybitSymbol, capitalSymbolObj] of Object.entries(
    // eslint-disable-next-line no-undef
    CAPITAL_CRYPTO,
  )) {
    const capitalSymbol = capitalSymbolObj.symbol;

    let candles;

    try {
      candles = await fetchCandles(bybitSymbol, timeframe, 4980);
    } catch (err) {
      continue;
    }

    if (candles.length < 3900) {
      console.log(`Not enough candles for ${bybitSymbol}`);
      continue;
    }

    const currentCandleTime = candles[candles.length - 1].openTime;

    const candleTime = dayjs.tz(
      currentCandleTime,
      "YYYY-MM-DD HH:mm:ss",
      "Australia/Brisbane",
    );

    const currentTime = dayjs().tz("Australia/Brisbane");

    const differenceInMinutes = currentTime.diff(candleTime, "minute");

    console.log(
      `Current candle time for ${capitalSymbol}: ${currentCandleTime}, difference in minutes: ${differenceInMinutes}`,
    );

    if (differenceInMinutes < 14) {
      await sleep(10);
    }

    console.log(`Scanning symbol: ${capitalSymbol}`);

    await sleep(2);

    const theLatestCandle = candles[candles.length - 1];

    const theCandleSize =
      ((theLatestCandle.high - theLatestCandle.low) / theLatestCandle.low) *
      100;

    const closes = candles.map((c) => c.close);

    const newCandles = candles.map((c) => ({
      openTime: dayjs(c.openTime).tz("Australia/Brisbane").valueOf(),
      closeTime: dayjs(c.openTime)
        .add(timeframe, "minutes")
        .tz("Australia/Brisbane")
        .valueOf(),
      time: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    const thePkamaLength = 150;
    const pkama = await powerKama(
      newCandles,
      thePkamaLength,
      bybitSymbol,
      timeframe,
    );

    console.log(`Latest Kama is - ${pkama[pkama.length - 1]}`);

    const currentKama = pkama[pkama.length - 1];

    const currentClose = closes[closes.length - 1];

    const tsi = computeTSI(closes, 100, 50, 13);

    const latestTsi = tsi.tsi[tsi.tsi.length - 1];
    const previousTsi = tsi.tsi[tsi.tsi.length - 2];

    if (currentClose > currentKama) {
      let onlyClose = false;
      let placeNew = true;

      if (previousTsi < 0 && latestTsi > 0) {
        if (theCandleSize > 2) {
          onlyClose = true;
          placeNew = false;
        }

        if (theCandleSize > 1 && ["BTCUSD", "ETHUSDT"].includes(bybitSymbol)) {
          onlyClose = true;
          placeNew = false;
        }

        if (placeNew) {
          await sendPushNotif(
            `${capitalSymbol} at 15 Minute - Placing Order, BULLISH,  at ${closes[closes.length - 1]}`,
          );
        } else {
          await sendPushNotif(
            `${capitalSymbol} at 15 Minute - Closing Order, BULLISH,  at ${closes[closes.length - 1]}`,
          );
        }
        allSignals.push({
          direction: "buy",
          symbol: capitalSymbol,
          price: currentClose,
          onlyClose: onlyClose,
          placeNew: placeNew,
          size: capitalSymbol.size,
        });
      } else if (previousTsi > 0 && latestTsi < 0) {
        onlyClose = true;
        placeNew = false;

        await sendPushNotif(
          `${capitalSymbol} at 15 Minute - Closing Order, BULLISH,  at ${closes[closes.length - 1]}`,
        );
        allSignals.push({
          direction: "buy",
          symbol: capitalSymbol,
          price: currentClose,
          onlyClose: onlyClose,
          size: capitalSymbol.size,
          placeNew: placeNew,
        });
      }
    } else if (currentClose < currentKama) {
      let onlyClose = false;
      let placeNew = true;

      if (previousTsi > 0 && latestTsi < 0) {
        if (theCandleSize > 2) {
          onlyClose = true;
          placeNew = false;
        }

        if (theCandleSize > 1 && ["BTCUSD", "ETHUSDT"].includes(bybitSymbol)) {
          onlyClose = true;
          placeNew = false;
        }

        if (placeNew) {
          await sendPushNotif(
            `${capitalSymbol} at 15 Minute - Placing Order, BULLISH,  at ${closes[closes.length - 1]}`,
          );
        } else {
          await sendPushNotif(
            `${capitalSymbol} at 15 Minute - Closing Order, BULLISH,  at ${closes[closes.length - 1]}`,
          );
        }
        allSignals.push({
          direction: "sell",
          symbol: capitalSymbol,
          price: currentClose,
          onlyClose: onlyClose,
          placeNew: placeNew,
          size: capitalSymbol.size,
        });
      } else if (previousTsi < 0 && latestTsi > 0) {
        onlyClose = true;
        placeNew = false;

        await sendPushNotif(
          `${capitalSymbol} at 15 Minute - Closing Order, BULLISH,  at ${closes[closes.length - 1]}`,
        );
        allSignals.push({
          direction: "sell",
          symbol: capitalSymbol,
          price: currentClose,
          onlyClose: onlyClose,
          placeNew: placeNew,
          size: capitalSymbol.size,
        });
      }
    }
  }

  if (allSignals.length > 0) {
    for (const signal of allSignals) {
      await sleep(1);
      await rabbit.publish("orders", signal);
    }
  }
}

module.exports = capitalCrypto;
