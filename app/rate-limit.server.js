const buckets = new Map();
const MAX_BUCKETS = 10_000;

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function getClientIp(request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0].trim();
    if (first) return first;
  }

  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function pruneBuckets(now, windowMs) {
  if (buckets.size < MAX_BUCKETS) {
    for (const [key, bucket] of buckets) {
      if (now - bucket.start >= windowMs * 2) {
        buckets.delete(key);
      }
    }
    return;
  }

  buckets.clear();
}

export function consumeRateLimit(key, windowMs, max) {
  const now = Date.now();
  pruneBuckets(now, windowMs);

  let bucket = buckets.get(key);
  if (!bucket || now - bucket.start >= windowMs) {
    bucket = { start: now, count: 0 };
  }

  bucket.count += 1;
  buckets.set(key, bucket);

  const retryAfterMs = Math.max(0, bucket.start + windowMs - now);

  return {
    allowed: bucket.count <= max,
    limit: max,
    remaining: Math.max(0, max - bucket.count),
    reset: Math.ceil((bucket.start + windowMs) / 1000),
    retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  };
}

export function getReviewsRateLimitConfig() {
  return {
    windowMs: toPositiveInt(process.env.JUDGEME_REVIEWS_RATE_LIMIT_WINDOW_MS, 60_000),
    max: toPositiveInt(process.env.JUDGEME_REVIEWS_RATE_LIMIT_MAX, 30),
  };
}

export function rateLimitHeaders(result) {
  return {
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(result.reset),
    "Access-Control-Expose-Headers":
      "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After",
  };
}
