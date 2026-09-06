require("../config/config");

const axios = require("axios");

const BASE_URLS = {
  demo: "https://demo-api-capital.backend-capital.com",
  live: "https://api-capital.backend-capital.com",
};

function getBaseUrl() {
  const env = "live"; // (process.env.CAPITAL_ENV || "demo").toLowerCase();
  return BASE_URLS[env] || BASE_URLS.demo;
}

// ---------------------------------------------------------------------------
// Module-level session state (implicit, auto-managed — no class needed)
// ---------------------------------------------------------------------------

let cachedSession = null; // { cst, securityToken, baseUrl, createdAt }
let sessionPromise = null; // in-flight login promise, to avoid duplicate logins

/**
 * Performs the actual login call against Capital.com and returns fresh
 * session tokens. Internal — not exported.
 */
async function authenticate() {
  const apiKey = process.env.CAPITAL_API_KEY;
  const identifier = process.env.CAPITAL_IDENTIFIER;
  const password = process.env.CAPITAL_PASSWORD;

  if (!apiKey || !identifier || !password) {
    throw new Error(
      "Missing CAPITAL_API_KEY, CAPITAL_IDENTIFIER or CAPITAL_PASSWORD env vars.",
    );
  }

  const baseUrl = getBaseUrl();

  const response = await axios.post(
    `${baseUrl}/api/v1/session`,
    { identifier, password, encryptedPassword: false },
    {
      headers: {
        "X-CAP-API-KEY": apiKey,
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    },
  );

  if (response.status !== 200) {
    throw new Error(
      `Session creation failed (${response.status}): ${JSON.stringify(response.data)}`,
    );
  }

  const cst = response.headers["cst"];
  const securityToken = response.headers["x-security-token"];

  if (!cst || !securityToken) {
    throw new Error(
      "Session created but auth tokens missing from response headers.",
    );
  }

  return { cst, securityToken, baseUrl, createdAt: Date.now() };
}

/**
 * Returns a valid cached session, creating one implicitly if none exists
 * yet. Concurrent calls share a single in-flight login request instead of
 * each triggering their own.
 */
async function getSession() {
  if (cachedSession) return cachedSession;

  if (!sessionPromise) {
    sessionPromise = authenticate()
      .then((session) => {
        cachedSession = session;
        return session;
      })
      .finally(() => {
        sessionPromise = null;
      });
  }

  return sessionPromise;
}

/**
 * Forces a fresh login, replacing any cached session. Used automatically
 * on 401 responses to refresh an expired session.
 */
async function refreshSession() {
  cachedSession = null;
  return getSession();
}

/**
 * Builds the auth headers for a given session.
 */
function buildAuthHeaders(session) {
  return {
    "X-CAP-API-KEY": process.env.CAPITAL_API_KEY,
    CST: session.cst,
    "X-SECURITY-TOKEN": session.securityToken,
    "Content-Type": "application/json",
  };
}

/**
 * Executes an authenticated HTTP request against the Capital.com API.
 * Automatically obtains a session on first use and automatically
 * refreshes + retries once if the session has expired (401).
 *
 * @param {(session: object) => Promise<import('axios').AxiosResponse>} makeRequest
 * @param {string} label - name used in error messages
 */
async function authorizedRequest(makeRequest, label) {
  let session = await getSession();
  let response = await makeRequest(session);

  if (response.status === 401) {
    // Session expired/invalid — refresh once and retry.
    session = await refreshSession();
    response = await makeRequest(session);
  }

  if (response.status >= 300) {
    throw new Error(
      `${label} failed (${response.status}): ${JSON.stringify(response.data)}`,
    );
  }

  return response;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * Places a new order (opens a position) on Capital.com.
 * Session is handled automatically — just call this directly.
 *
 * @param {object} params
 * @param {string} params.epic - instrument epic, e.g. "GOLD", "US500"
 * @param {'BUY'|'SELL'} params.direction
 * @param {number} params.size - position size
 * @param {number} [params.stopLevel] - absolute stop loss price level
 * @param {number} [params.profitLevel] - absolute take profit price level
 * @param {number} [params.stopDistance] - stop loss distance in points
 * @param {number} [params.profitDistance] - take profit distance in points
 * @param {boolean} [params.guaranteedStop=false]
 * @param {boolean} [params.trailingStop=false]
 * @param {number} [params.level] - limit price (only for limit/stop working orders); omit for market order
 * @param {'LIMIT'|'STOP'} [params.orderType='LIMIT'] - only relevant when `level` is provided
 *
 * @returns {Promise<object>} API response containing dealReference
 */
async function placeOrder(params) {
  const {
    epic,
    direction,
    size,
    stopLevel,
    profitLevel,
    stopDistance,
    profitDistance,
    guaranteedStop = false,
    trailingStop = false,
    level, // presence of `level` implies a working (limit/stop) order rather than market
    orderType,
  } = params || {};

  if (!epic || !direction || !size) {
    throw new Error("placeOrder requires epic, direction and size.");
  }

  const body = {
    epic,
    direction: direction.toUpperCase(),
    size,
    guaranteedStop,
    trailingStop,
  };

  if (stopLevel !== undefined) body.stopLevel = stopLevel;
  if (profitLevel !== undefined) body.profitLevel = profitLevel;
  if (stopDistance !== undefined) body.stopDistance = stopDistance;
  if (profitDistance !== undefined) body.profitDistance = profitDistance;

  // Market order = /positions endpoint. Limit/stop working order = /workingorders endpoint.
  const endpoint =
    level !== undefined ? "/api/v1/workingorders" : "/api/v1/positions";
  if (level !== undefined) {
    body.level = level;
    body.type = orderType || "LIMIT"; // LIMIT or STOP
  }

  const response = await authorizedRequest(
    (session) =>
      axios.post(`${session.baseUrl}${endpoint}`, body, {
        headers: buildAuthHeaders(session),
        validateStatus: () => true,
      }),
    "placeOrder",
  );

  return response.data;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

/**
 * Fetches all currently open positions. Session handled automatically.
 *
 * @returns {Promise<Array>} array of position objects
 */
async function getOpenPositions() {
  const response = await authorizedRequest(
    (session) =>
      axios.get(`${session.baseUrl}/api/v1/positions`, {
        headers: buildAuthHeaders(session),
        validateStatus: () => true,
      }),
    "getOpenPositions",
  );

  return response.data.positions || [];
}

/**
 * Returns all open positions matching a given epic.
 *
 * @param {string} epic
 * @returns {Promise<Array>}
 */
async function getPositionsByEpic(epic) {
  const positions = await getOpenPositions();
  return positions.filter((p) => p.market && p.market.epic === epic);
}

/**
 * Closes a single position by its dealId. Internal helper used by
 * closePositions(). A partial close is achieved by passing a `size`
 * smaller than the position's full size; omitting `size` (or passing
 * the full size) closes the position entirely.
 *
 * @param {string} dealId
 * @param {number} [size] - size to close; omit for full close
 * @returns {Promise<object>}
 */
async function closePositionById(dealId, size) {
  const response = await authorizedRequest(
    (session) =>
      axios.delete(`${session.baseUrl}/api/v1/positions/${dealId}`, {
        headers: buildAuthHeaders(session),
        data: size !== undefined ? { size } : {},
        validateStatus: () => true,
      }),
    `closePositionById(${dealId})`,
  );

  return response.data;
}

/**
 * Closes existing position(s) for a given epic. Session handled automatically.
 *
 * Behavior controlled by `full` and `size`:
 *   - full: true  (default)  -> closes every open position matching the epic
 *                                completely, regardless of `size`.
 *   - full: false            -> partial close. `size` is REQUIRED and is the
 *                                total quantity to close for that epic. If
 *                                several positions exist for the same epic,
 *                                the requested size is closed against them
 *                                in order (oldest first) until fulfilled.
 *
 * @param {object} params
 * @param {string} params.epic - instrument epic to close, e.g. "GOLD"
 * @param {boolean} [params.full=true] - true = full close, false = partial close
 * @param {number} [params.size] - required when full=false; amount to close
 *
 * @returns {Promise<Array>} array of { dealId, closedSize, result } entries
 */
async function closePositions(params) {
  const { epic, full = true, size } = params || {};

  if (!epic) {
    throw new Error("closePositions requires an epic.");
  }
  if (!full && (size === undefined || size <= 0)) {
    throw new Error("closePositions with full=false requires a positive size.");
  }

  const matchingPositions = await getPositionsByEpic(epic);

  if (matchingPositions.length === 0) {
    return [];
  }

  const results = [];

  if (full) {
    // Close every matching position entirely.
    for (const pos of matchingPositions) {
      const dealId = pos.position.dealId;
      const result = await closePositionById(dealId);
      results.push({ dealId, closedSize: pos.position.size, result });
    }
    return results;
  }

  // Partial close: consume `size` across matching positions (oldest first).
  let remaining = size;
  for (const pos of matchingPositions) {
    if (remaining <= 0) break;

    const dealId = pos.position.dealId;
    const posSize = pos.position.size;
    const closeSize = Math.min(remaining, posSize);

    const result = await closePositionById(dealId, closeSize);

    results.push({ dealId, closedSize: closeSize, result });
    remaining -= closeSize;
  }

  if (remaining > 0) {
    console.warn(
      `closePositions: requested size ${size} for epic "${epic}" exceeds total open size; ` +
        `${size - remaining} closed, ${remaining} could not be matched to an open position.`,
    );
  }

  return results;
}

async function placeTakeProfitOrders({ epic, direction, takeProfits = [] }) {
  if (!epic || !direction) {
    throw new Error("placeTakeProfitOrders requires epic and direction.");
  }

  if (!Array.isArray(takeProfits) || takeProfits.length === 0) {
    throw new Error("takeProfits must be a non-empty array.");
  }

  // To close a BUY position, TP orders must SELL.
  // To close a SELL position, TP orders must BUY.
  const closeDirection = direction.toUpperCase() === "BUY" ? "SELL" : "BUY";

  const results = [];

  for (const tp of takeProfits) {
    const { size, level, goodTillDate } = tp;

    if (!size || level === undefined) {
      throw new Error("Each take profit requires size and level.");
    }

    const result = await placeOrder({
      epic,
      direction: closeDirection,
      size,
      level,
      orderType: "LIMIT",
      ...(goodTillDate !== undefined && { goodTillDate }),
    });

    results.push({
      size,
      level,
      dealReference: result.dealReference,
    });
  }

  return results;
}

async function getCurrentPrice(epic) {
  const response = await authorizedRequest(
    (session) =>
      axios.get(
        `${session.baseUrl}/api/v1/markets?searchTerm=${encodeURIComponent(epic)}`,
        {
          headers: buildAuthHeaders(session),
          validateStatus: () => true,
        },
      ),
    "getCurrentPrice",
  );

  if (!response.data?.markets?.length) {
    throw new Error(`Market not found: ${epic}`);
  }

  const market = response.data.markets[0];

  return {
    bid: market.bid,
    offer: market.offer,
    epic: market.epic,
    pipPosition: market.pipPosition,
    tickSize: market.tickSize,
  };
}

async function getWorkingOrders() {
  const response = await authorizedRequest(
    (session) =>
      axios.get(`${session.baseUrl}/api/v1/workingorders`, {
        headers: buildAuthHeaders(session),
        validateStatus: () => true,
      }),
    "getWorkingOrders",
  );

  return response.data;
}

async function deleteWorkingOrder(dealId) {
  const response = await authorizedRequest(
    (session) =>
      axios.delete(`${session.baseUrl}/api/v1/workingorders/${dealId}`, {
        headers: buildAuthHeaders(session),
        validateStatus: () => true,
      }),
    "deleteWorkingOrder",
  );

  return response.data;
}

async function deleteWorkingOrdersForEpic(epic) {
  const data = await getWorkingOrders();

  const orders = data?.workingOrders || [];
  const matchingOrders = [];

  for (const order of orders) {
    if (order.workingOrderData.epic === epic) {
      matchingOrders.push(order.workingOrderData.dealId);
    }
  }

  for (const order of matchingOrders) {
    await deleteWorkingOrder(order);
  }

  return matchingOrders.length;
}

module.exports = {
  placeOrder,
  getOpenPositions,
  getPositionsByEpic,
  closePositions,
  closePositionById,
  placeTakeProfitOrders,
  getCurrentPrice,
  getWorkingOrders,
  deleteWorkingOrdersForEpic,
};
