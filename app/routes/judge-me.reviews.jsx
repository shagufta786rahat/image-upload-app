import { jsonCors, optionsCors } from "../cors.server";
import {
  JudgeMeError,
  createReview,
  errorResponsePayload,
  errorStatus,
  getReviewsForReviewer,
  parseProductIds,
} from "../judge-me.server";
import {
  consumeRateLimit,
  getClientIp,
  getReviewsRateLimitConfig,
  rateLimitHeaders,
} from "../rate-limit.server";

const METHODS = "GET, POST, OPTIONS";

function tooManyRequests(request, result) {
  return jsonCors(
    request,
    {
      success: false,
      error: "Too many review requests. Please try again later.",
    },
    429,
    METHODS,
    {
      ...rateLimitHeaders(result),
      "Retry-After": String(result.retryAfterSeconds),
    },
  );
}

function applyRateLimit(request, kind) {
  const { windowMs, max } = getReviewsRateLimitConfig();
  const result = consumeRateLimit(
    `judge-me-reviews:${kind}:${getClientIp(request)}`,
    windowMs,
    max,
  );
  return { result, blocked: !result.allowed };
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

  const { result, blocked } = applyRateLimit(request, "get");
  if (blocked) return tooManyRequests(request, result);

  const url = new URL(request.url);
  const reviewerEmail = url.searchParams.get("reviewer_email");
  const productIds = parseProductIds(url.searchParams.get("product_ids"));

  try {
    const { reviews, count, truncated } = await getReviewsForReviewer({
      reviewerEmail,
      productIds,
    });

    return jsonCors(
      request,
      {
        success: true,
        reviews,
        count,
        ...(truncated ? { truncated: true } : {}),
      },
      200,
      METHODS,
      rateLimitHeaders(result),
    );
  } catch (error) {
    if (!(error instanceof JudgeMeError)) {
      console.error("Judge.me reviews lookup failed");
    }

    return jsonCors(
      request,
      errorResponsePayload(error, "Unable to fetch Judge.me reviews"),
      errorStatus(error, 500),
      METHODS,
      rateLimitHeaders(result),
    );
  }
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }

  if (request.method !== "POST") {
    return jsonCors(
      request,
      { success: false, error: "Method not allowed. Use POST /judge-me/reviews" },
      405,
      METHODS,
    );
  }

  const { result, blocked } = applyRateLimit(request, "create");
  if (blocked) return tooManyRequests(request, result);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonCors(
      request,
      { success: false, error: "Invalid JSON body" },
      400,
      METHODS,
      rateLimitHeaders(result),
    );
  }

  try {
    const review = await createReview(body, { ipAddr: getClientIp(request) });
    return jsonCors(
      request,
      { success: true, review },
      201,
      METHODS,
      rateLimitHeaders(result),
    );
  } catch (error) {
    if (!(error instanceof JudgeMeError)) {
      console.error("Judge.me create review failed");
    }

    return jsonCors(
      request,
      errorResponsePayload(error, "Unable to create Judge.me review"),
      errorStatus(error, 500),
      METHODS,
      rateLimitHeaders(result),
    );
  }
}
