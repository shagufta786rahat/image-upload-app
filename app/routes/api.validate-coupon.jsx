import { jsonCors, optionsCors } from "../cors.server";
import {
  consumeRateLimit,
  getClientIp,
  rateLimitHeaders,
} from "../rate-limit.server";
import { getOfflineSession, shopifyGraphql } from "../shopify-api.server";

const METHODS = "GET, POST, OPTIONS";
const METAOBJECT_TYPE = "available_offers";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const ZERO_DECIMAL = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "JPY",
  "KMF",
  "KRW",
  "MGA",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const OFFERS_QUERY = `#graphql
  query AvailableOffers($cursor: String) {
    metaobjects(type: "${METAOBJECT_TYPE}", first: 100, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        handle
        fields {
          key
          value
          jsonValue
        }
      }
    }
  }
`;

const DISCOUNT_QUERY_TAIL = `
fragment ItemTargets on DiscountItems {
  __typename
  ... on AllDiscountItems {
    allItems
  }
  ... on DiscountProducts {
    products(first: 100) {
      nodes { id }
    }
    productVariants(first: 100) {
      nodes { id }
    }
  }
  ... on DiscountCollections {
    collections(first: 50) {
      nodes { id title }
    }
  }
}

fragment BuyerContext on DiscountContext {
  __typename
  ... on DiscountCustomers {
    customers { id }
  }
  ... on DiscountCustomerSegments {
    segments { id }
  }
}

fragment MinimumRequirement on DiscountMinimumRequirement {
  __typename
  ... on DiscountMinimumSubtotal {
    greaterThanOrEqualToSubtotal { amount currencyCode }
  }
  ... on DiscountMinimumQuantity {
    greaterThanOrEqualToQuantity
  }
}
`;

const CODE_DISCOUNT_FIELDS = `
  __typename
  ... on DiscountCodeBasic {
    title
    status
    startsAt
    endsAt
    usageLimit
    asyncUsageCount
    shortSummary
    summary
    minimumRequirement { ...MinimumRequirement }
    customerGets { items { ...ItemTargets } }
    context { ...BuyerContext }
  }
  ... on DiscountCodeFreeShipping {
    title
    status
    startsAt
    endsAt
    usageLimit
    asyncUsageCount
    shortSummary
    summary
    minimumRequirement { ...MinimumRequirement }
    context { ...BuyerContext }
  }
  ... on DiscountCodeBxgy {
    title
    status
    startsAt
    endsAt
    usageLimit
    asyncUsageCount
    summary
    customerBuys {
      items { ...ItemTargets }
      value {
        __typename
        ... on DiscountQuantity { quantity }
        ... on DiscountPurchaseAmount { amount }
      }
    }
    customerGets { items { ...ItemTargets } }
    context { ...BuyerContext }
  }
  ... on DiscountCodeApp {
    title
    status
    startsAt
    endsAt
    usageLimit
    asyncUsageCount
    context { ...BuyerContext }
  }
`;

function tooManyRequests(request, result) {
  return jsonCors(
    request,
    { ok: false, error: "Too many coupon checks. Please try again later." },
    429,
    METHODS,
    {
      ...rateLimitHeaders(result),
      "Cache-Control": "no-store",
      "Retry-After": String(result.retryAfterSeconds),
    },
  );
}

function fieldMap(fields = []) {
  const map = {};
  for (const field of fields) {
    map[field.key] = field;
  }
  return map;
}

function readField(fields, key) {
  const field = fields[key];
  if (!field) return null;
  if (field.jsonValue !== undefined && field.jsonValue !== null) {
    return field.jsonValue;
  }
  return field.value ?? null;
}

function richTextToPlain(node) {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(richTextToPlain).join("");
  if (typeof node !== "object") return "";
  if (node.type === "text" && typeof node.value === "string") return node.value;

  const children = Array.isArray(node.children)
    ? node.children.map(richTextToPlain).join("")
    : "";
  return children;
}

function asText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map(asText).filter(Boolean).join(", ");
  }
  return richTextToPlain(value).replace(/\s+/g, " ").trim();
}

function readCode(fields) {
  const raw =
    readField(fields, "discount_code") ??
    readField(fields, "coupon_code") ??
    readField(fields, "code");
  return asText(raw);
}

function readDescription(fields) {
  const raw = readField(fields, "description");
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return richTextToPlain(JSON.parse(trimmed)).replace(/\s+/g, " ").trim();
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  return richTextToPlain(raw).replace(/\s+/g, " ").trim();
}

function toOffer(node) {
  const fields = fieldMap(node?.fields || []);
  const code = readCode(fields);
  if (!code) return null;

  return {
    code,
    description: readDescription(fields),
  };
}

function mergeOffers(offers) {
  const merged = new Map();
  for (const offer of offers) {
    const key = offer.code.toLowerCase();
    if (!merged.has(key)) merged.set(key, offer);
  }
  return [...merged.values()];
}

function sameCode(left, right) {
  return String(left || "").trim().toLowerCase() === String(right || "").trim().toLowerCase();
}

function resourceGid(type, value) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  if (!raw || raw === "null") return null;
  if (raw.startsWith("gid://")) return raw;
  const match = raw.match(/(\d+)$/);
  if (!match) return null;
  return `gid://shopify/${type}/${match[1]}`;
}

function moneyPlaces(currency) {
  return ZERO_DECIMAL.has(String(currency || "").toUpperCase()) ? 0 : 2;
}

function moneyValue(amount, currency) {
  const places = moneyPlaces(currency);
  const factor = 10 ** places;
  return Math.round((Number(amount) || 0) * factor) / factor;
}

function formatMoney(amount, currency) {
  const code = String(currency || "").toUpperCase();
  return `${code} ${moneyValue(amount, code).toFixed(moneyPlaces(code))}`;
}

function lineAmount(item, currency) {
  const cents = Number(
    item?.original_line_price ??
      item?.originalLinePrice ??
      item?.line_price ??
      item?.final_line_price ??
      item?.linePrice,
  );
  if (Number.isFinite(cents)) {
    return moneyValue(ZERO_DECIMAL.has(currency) ? cents : cents / 100, currency);
  }
  const amount = Number(item?.line_amount ?? item?.lineAmount);
  return Number.isFinite(amount) ? moneyValue(amount, currency) : 0;
}

function normalizeCart(items, currency) {
  const code = String(currency || "INR").toUpperCase();
  const lines = (items || [])
    .map((item) => ({
      productId: resourceGid("Product", item?.product_id ?? item?.productId),
      variantId: resourceGid("ProductVariant", item?.variant_id ?? item?.variantId),
      productType: asText(item?.product_type || item?.productType || item?.product?.type),
      quantity: Math.max(0, Number(item?.quantity) || 0),
      lineAmount: lineAmount(item, code),
      title: asText(item?.title),
    }))
    .filter((line) => line.quantity > 0);

  return {
    currency: code,
    lines,
    subtotal: moneyValue(
      lines.reduce((sum, line) => sum + line.lineAmount, 0),
      code,
    ),
    quantity: lines.reduce((sum, line) => sum + line.quantity, 0),
  };
}

function unavailableOffer(code, applicability = "This coupon is not available") {
  return {
    code,
    description: "",
    applicable: false,
    disabled: true,
    applicability,
    discount_status: null,
  };
}

function discountSummary(discount) {
  return String(discount?.shortSummary || discount?.summary || discount?.title || "").trim();
}

function describe(reason, summary) {
  if (!reason) return summary || "Applies to your cart";
  if (!summary || reason.includes(summary)) return reason;
  return `${reason}. ${summary}`;
}

function offerResult(offer, discount, applicable, applicability) {
  return {
    code: offer.code,
    description: offer.description || discountSummary(discount),
    applicable,
    disabled: !applicable,
    applicability,
    discount_status: discount?.status || null,
  };
}

function availabilityFailure(discount, now) {
  if (!discount) return "This coupon is not available";
  if (discount.status === "EXPIRED") return "This coupon has expired";
  if (discount.status === "SCHEDULED") return "This coupon is not active yet";
  if (discount.status && discount.status !== "ACTIVE") return "This coupon is not active";
  if (discount.startsAt && new Date(discount.startsAt).getTime() > now) {
    return "This coupon is not active yet";
  }
  if (discount.endsAt && new Date(discount.endsAt).getTime() <= now) {
    return "This coupon has expired";
  }
  if (
    discount.usageLimit != null &&
    Number(discount.asyncUsageCount) >= Number(discount.usageLimit)
  ) {
    return "This coupon has reached its usage limit";
  }
  return null;
}

function buyerFailure(discount, customerGid, memberSegmentIds, membershipError) {
  const context = discount?.context;
  const type = context?.__typename;
  if (!type || type === "DiscountBuyerSelectionAll") return null;

  if (type === "DiscountCustomers") {
    if (!customerGid) return "Log in to use this coupon";
    const allowed = (context.customers || []).some((customer) => customer.id === customerGid);
    return allowed ? null : "This coupon is not available for your account";
  }

  if (type === "DiscountCustomerSegments") {
    if (!customerGid) return "Log in to use this coupon";
    if (membershipError) return "Could not verify this coupon for your account";
    const allowed = (context.segments || []).some((segment) => memberSegmentIds.has(segment.id));
    return allowed ? null : "This coupon is not available for your account";
  }

  return null;
}

function itemTargets(itemsField) {
  if (!itemsField || itemsField.__typename === "AllDiscountItems" || itemsField.allItems) {
    return {
      all: true,
      productIds: [],
      variantIds: [],
      collectionIds: [],
      collectionTitles: [],
    };
  }

  const collections = itemsField.collections?.nodes || [];
  return {
    all: false,
    productIds: (itemsField.products?.nodes || []).map((node) => node.id),
    variantIds: (itemsField.productVariants?.nodes || []).map((node) => node.id),
    collectionIds: collections.map((node) => node.id),
    collectionTitles: collections.map((node) => node.title).filter(Boolean),
  };
}

function matchingLines(cart, targets, collectionMap) {
  if (targets.all) return cart.lines;
  return cart.lines.filter((line) => {
    if (line.productId && targets.productIds.includes(line.productId)) return true;
    if (line.variantId && targets.variantIds.includes(line.variantId)) return true;
    const collections = collectionMap.get(line.productId) || [];
    return targets.collectionIds.some((id) => collections.includes(id));
  });
}

function missingItemsMessage(targets) {
  if (targets.collectionTitles.length) {
    return `Add ${targets.collectionTitles.join(", ")} to your cart to use this coupon`;
  }
  return "Add eligible items to your cart to use this coupon";
}

function quantityOf(lines) {
  return lines.reduce((sum, line) => sum + line.quantity, 0);
}

function minimumFailure(minimum, cart, eligibleLines) {
  if (!minimum) return null;

  if (minimum.__typename === "DiscountMinimumSubtotal") {
    const required = Number(minimum.greaterThanOrEqualToSubtotal?.amount);
    if (!Number.isFinite(required)) return null;
    if (moneyValue(cart.subtotal, cart.currency) >= moneyValue(required, cart.currency)) {
      return null;
    }
    return `Add ${formatMoney(required - cart.subtotal, cart.currency)} more to your cart to use this coupon`;
  }

  if (minimum.__typename === "DiscountMinimumQuantity") {
    const required = Number(minimum.greaterThanOrEqualToQuantity);
    const have = quantityOf(eligibleLines);
    if (!Number.isFinite(required) || have >= required) return null;
    const more = required - have;
    return `Add ${more} more eligible item${more === 1 ? "" : "s"} to use this coupon`;
  }

  return null;
}

function buysFailure(buys, lines, currency) {
  const value = buys?.value;
  if (value?.__typename === "DiscountPurchaseAmount") {
    const required = Number(value.amount);
    const spent = lines.reduce((sum, line) => sum + line.lineAmount, 0);
    if (
      Number.isFinite(required) &&
      moneyValue(spent, currency) < moneyValue(required, currency)
    ) {
      return `Add ${formatMoney(required - spent, currency)} more in eligible items to use this coupon`;
    }
    return lines.length ? null : "Add eligible items to your cart to use this coupon";
  }

  const required = Number(value?.quantity);
  const have = quantityOf(lines);
  if (Number.isFinite(required) && have < required) {
    const more = required - have;
    return `Add ${more} more eligible item${more === 1 ? "" : "s"} to use this coupon`;
  }
  if (!lines.length) return "Add eligible items to your cart to use this coupon";
  return null;
}

function discountUsesCollections(discount) {
  const groups = [discount?.customerGets?.items, discount?.customerBuys?.items];
  return groups.some((items) => itemTargets(items).collectionIds.length > 0);
}

function parseRuleset(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function rulesetCollectionIds(rulesets = []) {
  const ids = [];
  for (const ruleset of rulesets || []) {
    for (const value of Object.values(ruleset || {})) {
      if (!Array.isArray(value)) continue;
      for (const entry of value) {
        if (typeof entry?.id === "string" && entry.id.includes("/Collection/")) {
          ids.push(entry.id);
        }
      }
    }
  }
  return ids;
}

function comparisonOperator(rule) {
  const operator = rule?.con || rule?.mc;
  return typeof operator === "string" ? operator : "gte";
}

function passesComparison(actual, required, operator, currency) {
  const left = currency ? moneyValue(actual, currency) : Number(actual);
  const right = currency ? moneyValue(required, currency) : Number(required);
  if (operator === "gt") return left > right;
  if (operator === "lt") return left < right;
  if (operator === "lte" || operator === "le") return left <= right;
  if (operator === "eq" || operator === "e") return left === right;
  return left >= right;
}

function idSet(value) {
  const list = Array.isArray(value) ? value : value?.arr || [];
  const ids = new Set();
  for (const entry of list) {
    const raw = typeof entry === "string" || typeof entry === "number" ? entry : entry?.id;
    if (raw == null || raw === "") continue;
    const text = String(raw);
    ids.add(text);
    if (text.startsWith("gid://")) ids.add(text);
    const productId = resourceGid("Product", text);
    const variantId = resourceGid("ProductVariant", text);
    if (productId) ids.add(productId);
    if (variantId) ids.add(variantId);
  }
  return ids;
}

function linesMatchingSelector(config, selector, cart, collectionMap) {
  const spec = config?.[selector];
  if (!selector || selector === "none") return cart.lines;

  if (selector.includes("_col")) {
    const usableSet = new Set(
      [...idSet(spec)].filter((id) => id.includes("/Collection/")),
    );
    if (!usableSet.size) return cart.lines;
    return cart.lines.filter((line) =>
      (collectionMap.get(line.productId) || []).some((id) => usableSet.has(id)),
    );
  }

  if (selector.includes("_var")) {
    const ids = idSet(spec);
    if (!ids.size) return cart.lines;
    return cart.lines.filter((line) => line.variantId && ids.has(line.variantId));
  }

  if (selector.includes("_pv")) {
    const ids = idSet(spec);
    if (!ids.size) return cart.lines;
    return cart.lines.filter((line) => line.productId && ids.has(line.productId));
  }

  if (selector.includes("_pty")) {
    const list = spec?.arr || (spec?.val ? [spec.val] : []);
    const types = list
      .map((entry) => asText(typeof entry === "string" ? entry : entry?.title || entry?.value))
      .filter(Boolean)
      .map((type) => type.toLowerCase());
    if (!types.length) return cart.lines;
    return cart.lines.filter((line) =>
      types.includes(String(line.productType || "").toLowerCase()),
    );
  }

  return cart.lines;
}

function priceRuleForSelector(config, selector) {
  if (!selector?.startsWith("ct_i")) return null;
  const slot = selector.match(/_(\d)$/);
  if (slot) return config[`ct_i_pr_${slot[1]}`] || null;
  return config.ct_i_pr || null;
}

function linesForRulesetRule(config, rule, cart, collectionMap) {
  const selector = rule?.is;
  let lines = selector ? linesMatchingSelector(config, selector, cart, collectionMap) : cart.lines;
  const priceRule = priceRuleForSelector(config, selector);
  const minimumPrice = Number(priceRule?.amt);
  if (Number.isFinite(minimumPrice) && minimumPrice > 0) {
    lines = lines.filter((line) => {
      const unitPrice = line.quantity > 0 ? line.lineAmount / line.quantity : 0;
      return passesComparison(
        unitPrice,
        minimumPrice,
        comparisonOperator(priceRule),
        cart.currency,
      );
    });
  }
  return lines;
}

function quantityMessage(required, have) {
  const more = Math.max(1, Math.ceil(required - have));
  return `Add ${more} more item${more === 1 ? "" : "s"} to use this coupon`;
}

function selectedRulesetKeys(config) {
  const andKeys = [];
  const orKeys = [];
  for (const key of [config.ct_q, config.bi]) {
    if (key && key !== "none") andKeys.push(key);
  }
  for (const key of config.ct_and || []) {
    if (key && key !== "none") andKeys.push(key);
  }
  for (const key of config.ct_or || []) {
    if (key && key !== "none") orKeys.push(key);
  }
  return { andKeys, orKeys };
}

function evaluateRulesetKey(config, key, cart, collectionMap) {
  const rule = config[key];
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return null;

  const operator = comparisonOperator(rule);
  if (key === "bi_ct" || key.startsWith("ct_amt")) {
    const required = Number(rule.amt);
    if (!Number.isFinite(required) || required <= 0) return null;
    if (passesComparison(cart.subtotal, required, operator, cart.currency)) return null;
    return `Add ${formatMoney(required - cart.subtotal, cart.currency)} more to your cart to use this coupon`;
  }

  if (key.startsWith("ct_qty") || key.startsWith("ct_i") || key.startsWith("bi_li")) {
    const required = Number(rule.amt);
    if (!Number.isFinite(required) || required <= 0) return null;
    const lines = linesForRulesetRule(config, rule, cart, collectionMap);
    if (rule.t === "amt") {
      const spent = lines.reduce((sum, line) => sum + line.lineAmount, 0);
      if (passesComparison(spent, required, operator, cart.currency)) return null;
      return `Add ${formatMoney(required - spent, cart.currency)} more in eligible items to use this coupon`;
    }
    const have = rule.t === "cart" || rule.b === "cart" ? cart.quantity : quantityOf(lines);
    if (passesComparison(have, required, operator)) return null;
    return quantityMessage(required, have);
  }

  return null;
}

function rulesetFailure(rulesets, cart, collectionMap) {
  for (const ruleset of rulesets || []) {
    const { andKeys, orKeys } = selectedRulesetKeys(ruleset);
    for (const key of andKeys) {
      const failure = evaluateRulesetKey(ruleset, key, cart, collectionMap);
      if (failure) return failure;
    }
    if (!orKeys.length) continue;
    const failures = orKeys.map((key) => evaluateRulesetKey(ruleset, key, cart, collectionMap));
    if (failures.every(Boolean)) return failures.find(Boolean);
  }
  return null;
}

function offerExplanation(offer, discount) {
  const summary = discountSummary(discount);
  if (offer.description) return offer.description;
  if (summary && !sameCode(summary, offer.code)) return summary;
  return "";
}

function evaluateDiscount(offer, discount, cart, customerGid, memberSegmentIds, membershipError, collectionMap) {
  const summary = discountSummary(discount);
  const unavailable = availabilityFailure(discount, Date.now());
  if (unavailable) {
    return offerResult(offer, discount, false, describe(unavailable, summary));
  }

  const buyer = buyerFailure(discount, customerGid, memberSegmentIds, membershipError);
  if (buyer) return offerResult(offer, discount, false, describe(buyer, summary));

  if (!cart.lines.length) {
    return offerResult(
      offer,
      discount,
      false,
      describe("Add items to your cart to use this coupon", summary),
    );
  }

  const explanation = offerExplanation(offer, discount);
  const ruleMessage = rulesetFailure(discount.rulesets, cart, collectionMap);
  if (ruleMessage) {
    return offerResult(offer, discount, false, describe(ruleMessage, explanation));
  }

  if (discount.__typename === "DiscountCodeApp") {
    return offerResult(offer, discount, true, explanation || "Applies to your cart");
  }

  if (discount.__typename === "DiscountCodeBxgy") {
    const buyTargets = itemTargets(discount.customerBuys?.items);
    const buyLines = matchingLines(cart, buyTargets, collectionMap);
    const buyMessage = buysFailure(discount.customerBuys, buyLines, cart.currency);
    if (buyMessage) {
      return offerResult(offer, discount, false, describe(buyMessage, summary));
    }

    const getTargets = itemTargets(discount.customerGets?.items);
    if (!getTargets.all && !matchingLines(cart, getTargets, collectionMap).length) {
      return offerResult(
        offer,
        discount,
        false,
        describe(missingItemsMessage(getTargets), summary),
      );
    }

    return offerResult(offer, discount, true, summary || "Applies to your cart");
  }

  const targets = itemTargets(discount.customerGets?.items);
  const eligible = matchingLines(cart, targets, collectionMap);
  if (!targets.all && !eligible.length) {
    return offerResult(offer, discount, false, describe(missingItemsMessage(targets), summary));
  }

  const minimum = minimumFailure(
    discount.minimumRequirement,
    cart,
    targets.all ? cart.lines : eligible,
  );
  if (minimum) return offerResult(offer, discount, false, describe(minimum, summary));

  return offerResult(offer, discount, true, summary || "Applies to your cart");
}

async function readInput(request) {
  const url = new URL(request.url);
  let body = {};

  if (request.method === "POST") {
    try {
      body = await request.json();
    } catch {
      body = {};
    }
  }

  const shop = String(
    body.shop ||
      url.searchParams.get("shop") ||
      request.headers.get("x-shopify-shop-domain") ||
      "",
  ).trim();

  const code = String(body.code || url.searchParams.get("code") || "").trim();
  let items = [];
  if (Array.isArray(body.items)) items = body.items;
  else if (Array.isArray(body.cart?.items)) items = body.cart.items;

  return {
    shop,
    code: code.slice(0, 100),
    currency: String(body.currency || url.searchParams.get("currency") || "INR").trim(),
    customerId: body.customer_id ?? body.customerId ?? url.searchParams.get("customer_id"),
    items: items.slice(0, 250),
  };
}

async function fetchAvailableOffers(shop, accessToken) {
  const offers = [];
  let cursor = null;

  while (offers.length < 500) {
    const { data, accessToken: token } = await shopifyGraphql(
      shop,
      accessToken,
      OFFERS_QUERY,
      { cursor },
    );
    accessToken = token;

    const connection = data?.data?.metaobjects;
    for (const node of connection?.nodes || []) {
      const offer = toOffer(node);
      if (offer) offers.push(offer);
    }

    const nextCursor = connection?.pageInfo?.endCursor || null;
    if (!connection?.pageInfo?.hasNextPage || !nextCursor || nextCursor === cursor) {
      break;
    }
    cursor = nextCursor;
  }

  return { offers: mergeOffers(offers), accessToken };
}

async function fetchDiscountsByCodes(shop, accessToken, codes) {
  const discounts = new Map();

  for (let start = 0; start < codes.length; start += 5) {
    const chunk = codes.slice(start, start + 5);
    const variables = {};
    const selections = chunk.map((code, index) => {
      variables[`code${index}`] = code;
      return `d${index}: codeDiscountNodeByCode(code: $code${index}) {
        conditional: metafield(namespace: "EveryPossibleDiscount", key: "metaconfigconditional") { value }
        bxgy: metafield(namespace: "EveryPossibleDiscount", key: "metaconfigbxgy") { value }
        codeDiscount { ${CODE_DISCOUNT_FIELDS} }
      }`;
    });
    const variableDefs = chunk.map((_, index) => `$code${index}: String!`).join(", ");
    const query = `#graphql
      query CouponDiscounts(${variableDefs}) {
        ${selections.join("\n")}
      }
      ${DISCOUNT_QUERY_TAIL}
    `;

    const { data, accessToken: token } = await shopifyGraphql(
      shop,
      accessToken,
      query,
      variables,
    );
    accessToken = token;

    chunk.forEach((code, index) => {
      const node = data?.data?.[`d${index}`];
      const discount = node?.codeDiscount || null;
      if (discount) {
        discount.rulesets = [parseRuleset(node?.conditional?.value), parseRuleset(node?.bxgy?.value)].filter(
          Boolean,
        );
      }
      discounts.set(code.toLowerCase(), discount);
    });
  }

  return { discounts, accessToken };
}

async function fetchProductCollections(shop, accessToken, productIds) {
  const collectionMap = new Map();
  const ids = [...new Set(productIds.filter(Boolean))];

  for (let start = 0; start < ids.length; start += 50) {
    const slice = ids.slice(start, start + 50);
    const { data, accessToken: token } = await shopifyGraphql(
      shop,
      accessToken,
      `#graphql
        query CartProductCollections($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              collections(first: 100) {
                nodes { id }
              }
            }
          }
        }
      `,
      { ids: slice },
    );
    accessToken = token;

    for (const node of data?.data?.nodes || []) {
      if (!node?.id) continue;
      collectionMap.set(
        node.id,
        (node.collections?.nodes || []).map((collection) => collection.id),
      );
    }
  }

  return { collectionMap, accessToken };
}

async function fetchRulesetCollectionMembership(shop, accessToken, productIds, collectionIds) {
  const collectionMap = new Map();
  const products = [...new Set(productIds.filter(Boolean))];
  const collections = [
    ...new Set(collectionIds.filter((id) => /^gid:\/\/shopify\/Collection\/\d+$/.test(id))),
  ];
  if (!products.length || !collections.length) {
    return { collectionMap, accessToken };
  }

  const aliases = collections
    .map((id, index) => `c${index}: inCollection(id: "${id}")`)
    .join("\n");

  for (let start = 0; start < products.length; start += 50) {
    const slice = products.slice(start, start + 50);
    const { data, accessToken: token } = await shopifyGraphql(
      shop,
      accessToken,
      `#graphql
        query RulesetCollectionMembership($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              ${aliases}
            }
          }
        }
      `,
      { ids: slice },
    );
    accessToken = token;

    for (const node of data?.data?.nodes || []) {
      if (!node?.id) continue;
      const memberOf = collections.filter((_, index) => node[`c${index}`]);
      collectionMap.set(node.id, memberOf);
    }
  }

  return { collectionMap, accessToken };
}

function mergeCollectionMaps(target, extra) {
  for (const [productId, ids] of extra) {
    const current = new Set(target.get(productId) || []);
    for (const id of ids) current.add(id);
    target.set(productId, [...current]);
  }
}

async function fetchSegmentMembership(shop, accessToken, customerGid, segmentIds) {
  const memberSegmentIds = new Set();
  const ids = [...new Set(segmentIds.filter(Boolean))];

  for (let start = 0; start < ids.length; start += 50) {
    const slice = ids.slice(start, start + 50);
    const { data, accessToken: token } = await shopifyGraphql(
      shop,
      accessToken,
      `#graphql
        query CouponSegmentMembership($customerId: ID!, $segmentIds: [ID!]!) {
          customerSegmentMembership(customerId: $customerId, segmentIds: $segmentIds) {
            memberships {
              isMember
              segmentId
            }
          }
        }
      `,
      { customerId: customerGid, segmentIds: slice },
    );
    accessToken = token;

    for (const membership of data?.data?.customerSegmentMembership?.memberships || []) {
      if (membership?.isMember && membership.segmentId) {
        memberSegmentIds.add(membership.segmentId);
      }
    }
  }

  return { memberSegmentIds, accessToken };
}

function segmentIdsFromDiscounts(discounts) {
  const ids = [];
  for (const discount of discounts.values()) {
    if (discount?.context?.__typename !== "DiscountCustomerSegments") continue;
    for (const segment of discount.context.segments || []) {
      if (segment?.id) ids.push(segment.id);
    }
  }
  return ids;
}

async function handleValidateCoupon(request) {
  const limit = consumeRateLimit(
    `validate-coupon:${getClientIp(request)}`,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX,
  );
  if (!limit.allowed) return tooManyRequests(request, limit);

  const { shop, code, currency, customerId, items } = await readInput(request);
  if (!shop) {
    return jsonCors(
      request,
      { ok: false, error: "Missing shop" },
      400,
      METHODS,
      { "Cache-Control": "no-store" },
    );
  }

  const offline = await getOfflineSession(shop);
  if (!offline) {
    return jsonCors(
      request,
      { ok: false, error: "Offline token not found" },
      401,
      METHODS,
      { "Cache-Control": "no-store" },
    );
  }

  let accessToken = offline.accessToken;
  const listed = await fetchAvailableOffers(shop, accessToken);
  accessToken = listed.accessToken;

  const lookup = [...listed.offers];
  if (code && !lookup.some((offer) => sameCode(offer.code, code))) {
    lookup.push({ code, description: "" });
  }

  const discountLookup = await fetchDiscountsByCodes(
    shop,
    accessToken,
    lookup.map((offer) => offer.code),
  );
  accessToken = discountLookup.accessToken;

  const cart = normalizeCart(items, currency);
  const customerGid = resourceGid("Customer", customerId);
  const rulesetCollectionIdsForCart = [
    ...discountLookup.discounts.values(),
  ].flatMap((discount) => rulesetCollectionIds(discount?.rulesets));
  const needsShopifyCollections = [...discountLookup.discounts.values()].some(
    discountUsesCollections,
  );

  let collectionMap = new Map();
  const productIds = cart.lines.map((line) => line.productId);
  if (rulesetCollectionIdsForCart.length) {
    const membership = await fetchRulesetCollectionMembership(
      shop,
      accessToken,
      productIds,
      rulesetCollectionIdsForCart,
    );
    collectionMap = membership.collectionMap;
    accessToken = membership.accessToken;
  }
  if (needsShopifyCollections) {
    const collections = await fetchProductCollections(shop, accessToken, productIds);
    mergeCollectionMaps(collectionMap, collections.collectionMap);
    accessToken = collections.accessToken;
  }

  let memberSegmentIds = new Set();
  let membershipError = false;
  const segmentIds = segmentIdsFromDiscounts(discountLookup.discounts);
  if (customerGid && segmentIds.length) {
    try {
      const membership = await fetchSegmentMembership(
        shop,
        accessToken,
        customerGid,
        segmentIds,
      );
      memberSegmentIds = membership.memberSegmentIds;
    } catch {
      membershipError = true;
    }
  }

  const evaluated = lookup.map((offer) => {
    const discount = discountLookup.discounts.get(offer.code.toLowerCase()) || null;
    if (!discount) return unavailableOffer(offer.code);
    return evaluateDiscount(
      offer,
      discount,
      cart,
      customerGid,
      memberSegmentIds,
      membershipError,
      collectionMap,
    );
  });

  const listedCodes = new Set(listed.offers.map((offer) => offer.code.toLowerCase()));
  const payload = {
    ok: true,
    offers: evaluated.filter((offer) => listedCodes.has(offer.code.toLowerCase())),
  };

  if (code) {
    payload.offer =
      evaluated.find((offer) => sameCode(offer.code, code)) || unavailableOffer(code);
  }

  return jsonCors(request, payload, 200, METHODS, {
    ...rateLimitHeaders(limit),
    "Cache-Control": "no-store",
  });
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }

  if (request.method !== "GET") {
    return jsonCors(request, { ok: false, error: "Method not allowed" }, 405, METHODS);
  }

  try {
    return await handleValidateCoupon(request);
  } catch (error) {
    return jsonCors(
      request,
      { ok: false, error: error.message || "Failed to validate coupon" },
      500,
      METHODS,
      { "Cache-Control": "no-store" },
    );
  }
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }

  if (request.method !== "POST") {
    return jsonCors(request, { ok: false, error: "Method not allowed" }, 405, METHODS);
  }

  try {
    return await handleValidateCoupon(request);
  } catch (error) {
    return jsonCors(
      request,
      { ok: false, error: error.message || "Failed to validate coupon" },
      500,
      METHODS,
      { "Cache-Control": "no-store" },
    );
  }
}
