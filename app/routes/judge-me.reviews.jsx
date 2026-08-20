import { jsonCors, optionsCors } from "../cors.server";
import {
  JudgeMeError,
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

const METHODS = "GET, OPTIONS";

function tooManyRequests(request, result) {
  return jsonCors(
    request,
    {
      success: false,
      error: "Too many review lookup requests. Please try again later.",
    },
    429,
    METHODS,
    {
      ...rateLimitHeaders(result),
      "Retry-After": String(result.retryAfterSeconds),
    },
  );
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

  const { windowMs, max } = getReviewsRateLimitConfig();
  const rateLimit = consumeRateLimit(
    `judge-me-reviews:${getClientIp(request)}`,
    windowMs,
    max,
  );

  if (!rateLimit.allowed) {
    return tooManyRequests(request, rateLimit);
  }

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
      rateLimitHeaders(rateLimit),
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
      rateLimitHeaders(rateLimit),
    );
  }
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }

  return jsonCors(
    request,
    {
      success: false,
      error: "Method not allowed. Use GET /judge-me/reviews",
    },
    405,
    METHODS,
  );
}
