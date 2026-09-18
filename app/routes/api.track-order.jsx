import { jsonCors, optionsCors } from "../cors.server";
import {
  consumeRateLimit,
  getClientIp,
  rateLimitHeaders,
} from "../rate-limit.server";
import {
  fetchTrackingPayload,
  normalizeOrderId,
} from "../track-order.server";

const METHODS = "GET, POST, OPTIONS";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;

function tooManyRequests(request, result) {
  return jsonCors(
    request,
    { error: "Too many tracking requests. Please try again later." },
    429,
    METHODS,
    {
      ...rateLimitHeaders(result),
      "Retry-After": String(result.retryAfterSeconds),
    },
  );
}

async function readOrderId(request) {
  const url = new URL(request.url);
  let orderId =
    url.searchParams.get("order_id") || url.searchParams.get("orderId");

  if (request.method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    orderId = body.order_id || body.orderId || orderId;
  }

  return normalizeOrderId(orderId);
}

async function handleTrackOrder(request) {
  const limit = consumeRateLimit(
    `track-order:${getClientIp(request)}`,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX,
  );
  if (!limit.allowed) return tooManyRequests(request, limit);

  const orderId = await readOrderId(request);
  if (!orderId) {
    return jsonCors(
      request,
      { error: "Order ID is required." },
      400,
      METHODS,
    );
  }

  try {
    const payload = await fetchTrackingPayload(orderId);
    return jsonCors(request, payload, 200, METHODS, rateLimitHeaders(limit));
  } catch (error) {
    console.error("Track order proxy failed:", error);
    return jsonCors(
      request,
      { error: error.message || "Unable to load tracking." },
      502,
      METHODS,
    );
  }
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }

  if (request.method !== "GET") {
    return jsonCors(request, { error: "Method not allowed" }, 405, METHODS);
  }

  return handleTrackOrder(request);
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }

  if (request.method !== "POST") {
    return jsonCors(request, { error: "Method not allowed" }, 405, METHODS);
  }

  return handleTrackOrder(request);
}
