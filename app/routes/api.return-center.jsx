import { jsonCors, optionsCors } from "../cors.server";
import {
  getClientIp,
  consumeRateLimit,
  rateLimitHeaders,
} from "../rate-limit.server";
import {
  getReturnCenterSignedUrl,
  normalizeContact,
  normalizeOrderId,
} from "../return-center.server";

const METHODS = "GET, POST, OPTIONS";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;

function tooManyRequests(request, result) {
  return jsonCors(
    request,
    {
      success: false,
      error: "Too many return requests. Please try again later.",
    },
    429,
    METHODS,
    {
      ...rateLimitHeaders(result),
      "Retry-After": String(result.retryAfterSeconds),
    },
  );
}

function applyRateLimit(request) {
  const result = consumeRateLimit(
    `return-center:${getClientIp(request)}`,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX,
  );
  return { result, blocked: !result.allowed };
}

async function readParams(request) {
  const url = new URL(request.url);
  let orderId = url.searchParams.get("order_id") || url.searchParams.get("orderId");
  let contact =
    url.searchParams.get("contact") ||
    url.searchParams.get("phone") ||
    url.searchParams.get("phone_number");

  if (request.method === "POST") {
    let body = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    orderId = body.order_id || body.orderId || orderId;
    contact = body.contact || body.phone || body.phone_number || contact;
  }

  return {
    orderId: normalizeOrderId(orderId),
    contact: normalizeContact(contact),
  };
}

async function handleReturnCenter(request) {
  const { result, blocked } = applyRateLimit(request);
  if (blocked) return tooManyRequests(request, result);

  const { orderId, contact } = await readParams(request);
  if (!orderId || !contact) {
    return jsonCors(
      request,
      {
        success: false,
        error: "Order ID and phone number are required.",
      },
      400,
      METHODS,
    );
  }

  try {
    const signedUrl = await getReturnCenterSignedUrl({ orderId, contact });
    return jsonCors(
      request,
      {
        success: true,
        data: { signed_url: signedUrl },
      },
      200,
      METHODS,
      rateLimitHeaders(result),
    );
  } catch (error) {
    console.error("Return Center proxy failed:", error);
    return jsonCors(
      request,
      {
        success: false,
        error: error.message || "Failed to open Return Center.",
      },
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
    return jsonCors(
      request,
      { success: false, error: "Method not allowed" },
      405,
      METHODS,
    );
  }

  return handleReturnCenter(request);
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }

  if (request.method !== "POST") {
    return jsonCors(
      request,
      { success: false, error: "Method not allowed" },
      405,
      METHODS,
    );
  }

  return handleReturnCenter(request);
}
