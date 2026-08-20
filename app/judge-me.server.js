const REVIEW_REQUEST_URL = "https://judge.me/api/orders/send_manual_review_request";
const REVIEWS_URL = "https://api.judge.me/api/v1/reviews";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_PAGES = 50;
const MAX_PRODUCT_IDS = 100;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DMY_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/;
const SECRET_QUERY_PATTERN = /(?:api_token|token|access_token)=([^&"'\s]+)/gi;
const SECRET_HEADER_PATTERN = /(?:X-Api-Token|Bearer)\s*[:=]?\s*([^\s"',]+)/gi;
const SECRET_KEYS = new Set([
  "api_token",
  "apiToken",
  "token",
  "access_token",
  "private_api_token",
  "privateApiToken",
]);

export class JudgeMeError extends Error {
  constructor(message, { status = 502, details = null } = {}) {
    super(message);
    this.name = "JudgeMeError";
    this.status = status;
    this.details = details;
  }
}

function toPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function isValidCalendarDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1970) {
    return false;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function redactSecrets(value) {
  if (value == null) return value;

  if (typeof value === "string") {
    return value
      .replace(SECRET_QUERY_PATTERN, (match) =>
        `${match.slice(0, match.indexOf("=") + 1)}[redacted]`,
      )
      .replace(SECRET_HEADER_PATTERN, (match) =>
        match.toLowerCase().includes("bearer")
          ? "Bearer [redacted]"
          : "X-Api-Token [redacted]",
      );
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item));
  }

  if (typeof value === "object") {
    const next = {};
    for (const [key, nested] of Object.entries(value)) {
      next[key] = SECRET_KEYS.has(key) ? "[redacted]" : redactSecrets(nested);
    }
    return next;
  }

  return value;
}

function safeDetails(value) {
  if (value == null || value === "") return null;
  try {
    return redactSecrets(value);
  } catch {
    return "Judge.me returned an error";
  }
}

export function getJudgeMeConfig() {
  const apiToken = String(process.env.JUDGEME_PRIVATE_API_TOKEN || "").trim();
  const shopDomain = String(
    process.env.JUDGEME_SHOP_DOMAIN || "saltyjewels.myshopify.com",
  ).trim();
  const timeoutMs = toPositiveInt(
    process.env.JUDGEME_REQUEST_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const perPage = Math.min(
    100,
    toPositiveInt(process.env.JUDGEME_REVIEWS_PER_PAGE, DEFAULT_PER_PAGE),
  );
  const maxPages = toPositiveInt(
    process.env.JUDGEME_REVIEWS_MAX_PAGES,
    DEFAULT_MAX_PAGES,
  );

  if (!apiToken) {
    throw new JudgeMeError("Judge.me is not configured", { status: 500 });
  }

  if (!shopDomain) {
    throw new JudgeMeError("Judge.me shop domain is not configured", {
      status: 500,
    });
  }

  return { apiToken, shopDomain, timeoutMs, perPage, maxPages };
}

export function isValidEmail(value) {
  if (typeof value !== "string") return false;
  const email = value.trim();
  return email.length > 3 && email.length <= 254 && EMAIL_PATTERN.test(email);
}

export function toJudgeMeDate(value, fieldName) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  let year;
  let month;
  let day;
  const dmy = raw.match(DMY_DATE_PATTERN);
  const iso = raw.match(ISO_DATE_PATTERN);

  if (dmy) {
    day = Number(dmy[1]);
    month = Number(dmy[2]);
    year = Number(dmy[3]);
  } else if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    throw new JudgeMeError(`${fieldName} must be in dd/mm/yyyy format`, {
      status: 400,
      details: { field: fieldName },
    });
  }

  if (!isValidCalendarDate(year, month, day)) {
    throw new JudgeMeError(`${fieldName} is not a valid date`, {
      status: 400,
      details: { field: fieldName },
    });
  }

  return `${pad2(day)}/${pad2(month)}/${year}`;
}

function normalizeShopifyId(value) {
  if (value == null || value === "") return "";
  const raw = String(value).trim();
  if (!raw) return "";
  const gidMatch = raw.match(/\/(\d+)\s*$/);
  if (gidMatch) return gidMatch[1];
  const digits = raw.replace(/\s+/g, "");
  return /^\d+$/.test(digits) ? digits : raw;
}

export function parseProductIds(raw) {
  if (raw == null || raw === "") return [];
  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  const ids = [];
  const seen = new Set();

  for (const value of values) {
    const id = normalizeShopifyId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_PRODUCT_IDS) break;
  }

  return ids;
}

function requiredString(body, field) {
  const value = body?.[field];
  if (value == null) return "";
  return String(value).trim();
}

export function validateReviewRequestBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new JudgeMeError("Request body must be a JSON object", {
      status: 400,
    });
  }

  const reviewerName = requiredString(body, "reviewer_name");
  const reviewerEmail = requiredString(body, "reviewer_email").toLowerCase();
  const shopifyProductId = normalizeShopifyId(body.shopify_product_id);
  const productHandle = requiredString(body, "product_handle");
  const missing = [];

  if (!reviewerName) missing.push("reviewer_name");
  if (!reviewerEmail) missing.push("reviewer_email");
  if (!shopifyProductId) missing.push("shopify_product_id");
  if (!productHandle) missing.push("product_handle");
  if (body.fulfilled_at == null || String(body.fulfilled_at).trim() === "") {
    missing.push("fulfilled_at");
  }

  if (missing.length > 0) {
    throw new JudgeMeError("Missing required fields", {
      status: 400,
      details: { fields: missing },
    });
  }

  if (reviewerName.length > 200) {
    throw new JudgeMeError("reviewer_name is too long", { status: 400 });
  }
  if (productHandle.length > 255) {
    throw new JudgeMeError("product_handle is too long", { status: 400 });
  }
  if (!isValidEmail(reviewerEmail)) {
    throw new JudgeMeError("reviewer_email must be a valid email address", {
      status: 400,
      details: { field: "reviewer_email" },
    });
  }

  let quantity = 1;
  if (body.quantity != null && body.quantity !== "") {
    quantity = Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
      throw new JudgeMeError("quantity must be a positive integer", {
        status: 400,
        details: { field: "quantity" },
      });
    }
  }

  const fulfilledAt = toJudgeMeDate(body.fulfilled_at, "fulfilled_at");
  const processedAt =
    body.processed_at == null || String(body.processed_at).trim() === ""
      ? null
      : toJudgeMeDate(body.processed_at, "processed_at");

  return {
    reviewer_name: reviewerName,
    reviewer_email: reviewerEmail,
    shopify_product_id: shopifyProductId,
    product_handle: productHandle,
    fulfilled_at: fulfilledAt,
    quantity,
    ...(processedAt ? { processed_at: processedAt } : {}),
  };
}

function parseJsonSafely(text) {
  if (!text || !String(text).trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new JudgeMeError("Judge.me returned a malformed response", {
      status: 502,
    });
  }
}

function extractJudgeMeErrorMessage(payload, status) {
  if (payload == null) {
    return `Judge.me request failed (${status})`;
  }
  if (typeof payload === "string") {
    const trimmed = payload.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return trimmed.slice(0, 300) || `Judge.me request failed (${status})`;
  }
  if (typeof payload.error === "string") return payload.error;
  if (typeof payload.message === "string") return payload.message;
  if (Array.isArray(payload.errors)) {
    return payload.errors
      .map((item) => (typeof item === "string" ? item : item?.message))
      .filter(Boolean)
      .join(", ");
  }
  if (payload.errors && typeof payload.errors === "object") {
    return Object.values(payload.errors).flat().filter(Boolean).join(", ");
  }
  return `Judge.me request failed (${status})`;
}

function statusForJudgeMe(status) {
  if (status === 401 || status === 403) return 502;
  if (status >= 400 && status < 500) return status;
  return 502;
}

async function judgeMeFetch(url, { method = "GET", body, headers } = {}) {
  const { apiToken, shopDomain, timeoutMs } = getJudgeMeConfig();
  const requestUrl = new URL(url);
  requestUrl.searchParams.set("shop_domain", shopDomain);
  requestUrl.searchParams.set("api_token", apiToken);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(requestUrl, {
      method,
      headers: {
        Accept: "application/json",
        "X-Api-Token": apiToken,
        ...headers,
      },
      body,
      signal: controller.signal,
    });

    const rawText = await response.text();
    const contentType = response.headers.get("content-type") || "";
    let payload = null;

    if (rawText.trim()) {
      const looksLikeJson =
        contentType.includes("application/json") ||
        rawText.trim().startsWith("{") ||
        rawText.trim().startsWith("[");

      if (looksLikeJson) {
        payload = parseJsonSafely(rawText);
      } else if (!response.ok) {
        payload = rawText.slice(0, 500);
      } else {
        payload = { message: "Judge.me request completed" };
      }
    }

    if (!response.ok) {
      throw new JudgeMeError(
        redactSecrets(
          extractJudgeMeErrorMessage(payload, response.status) ||
            "Unable to complete Judge.me request",
        ),
        {
          status: statusForJudgeMe(response.status),
          details: safeDetails(payload),
        },
      );
    }

    return payload;
  } catch (error) {
    if (error instanceof JudgeMeError) throw error;

    if (error?.name === "AbortError") {
      throw new JudgeMeError("Judge.me request timed out", { status: 504 });
    }

    throw new JudgeMeError("Unable to reach Judge.me", {
      status: 502,
      details: { reason: "network_error" },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function hasJudgeMeBusinessError(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.success === false) return true;
  if (typeof payload.error === "string" && payload.error.trim()) return true;
  if (Array.isArray(payload.errors) && payload.errors.length > 0) return true;
  return false;
}

export async function sendManualReviewRequest(input) {
  const payload = validateReviewRequestBody(input);
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(payload)) {
    if (value != null && value !== "") {
      body.set(key, String(value));
    }
  }

  const data = await judgeMeFetch(REVIEW_REQUEST_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (hasJudgeMeBusinessError(data)) {
    throw new JudgeMeError(
      extractJudgeMeErrorMessage(data, 400) ||
        "Unable to create Judge.me review request",
      {
        status: 400,
        details: safeDetails(data),
      },
    );
  }

  return safeDetails(data) ?? data;
}

function productExternalId(review) {
  const value =
    review?.product_external_id ??
    review?.product?.external_id ??
    review?.product?.product_external_id ??
    null;
  if (value == null || value === "") return null;
  const normalized = normalizeShopifyId(value);
  const asNumber = Number(normalized);
  return Number.isFinite(asNumber) && String(asNumber) === String(normalized)
    ? asNumber
    : normalized;
}

export function sanitizeReview(review) {
  if (!review || typeof review !== "object") return null;

  return {
    id: review.id ?? null,
    title: review.title ?? "",
    body: review.body ?? "",
    rating: Number(review.rating) || 0,
    product_external_id: productExternalId(review),
    product_title: review.product_title ?? review.product?.title ?? "",
    product_handle: review.product_handle ?? review.product?.handle ?? "",
    verified: review.verified ?? null,
    published: Boolean(review.published),
    created_at: review.created_at ?? null,
  };
}

function extractReviews(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.reviews)) return payload.reviews;
  return [];
}

export async function getReviewsForReviewer({ reviewerEmail, productIds = [] }) {
  const email = String(reviewerEmail || "").trim().toLowerCase();
  if (!isValidEmail(email)) {
    throw new JudgeMeError("reviewer_email must be a valid email address", {
      status: 400,
      details: { field: "reviewer_email" },
    });
  }

  const { perPage, maxPages } = getJudgeMeConfig();
  const collected = [];
  let truncated = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(REVIEWS_URL);
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    url.searchParams.set("reviewer_email", email);

    const payload = await judgeMeFetch(url);
    const pageReviews = extractReviews(payload);

    if (pageReviews.length === 0) break;

    collected.push(...pageReviews);

    if (pageReviews.length < perPage) break;
    if (page === maxPages) truncated = true;
  }

  const allowedIds = new Set(productIds.map((id) => String(id)));
  const sanitized = collected
    .map(sanitizeReview)
    .filter(Boolean)
    .filter((review) => {
      if (allowedIds.size === 0) return true;
      if (review.product_external_id == null) return false;
      return allowedIds.has(String(review.product_external_id));
    });

  return {
    reviews: sanitized,
    count: sanitized.length,
    truncated,
  };
}

export function errorResponsePayload(error, fallbackMessage) {
  const message = redactSecrets(
    error instanceof JudgeMeError ? error.message : fallbackMessage,
  );
  const details =
    error instanceof JudgeMeError ? safeDetails(error.details) : null;

  return {
    success: false,
    error: message || fallbackMessage,
    ...(details != null ? { details } : {}),
  };
}

export function errorStatus(error, fallback = 500) {
  if (error instanceof JudgeMeError) return error.status;
  return fallback;
}
