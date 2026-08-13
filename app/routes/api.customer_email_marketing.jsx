import { jsonCors, optionsCors } from "../cors.server";
import { getOfflineSession, shopifyGraphql } from "../shopify-api.server";

const METHODS = "GET, POST, PUT, OPTIONS";
const ACCEPTED_STATES = new Set(["SUBSCRIBED", "UNSUBSCRIBED", "PENDING"]);

const CUSTOMER_EMAIL_MARKETING_FRAGMENT = `
  id
  defaultEmailAddress {
    emailAddress
    marketingState
    marketingOptInLevel
    marketingUpdatedAt
  }
`;

const GET_EMAIL_MARKETING_QUERY = `#graphql
  query CustomerEmailMarketing($id: ID!) {
    customer(id: $id) {
      ${CUSTOMER_EMAIL_MARKETING_FRAGMENT}
    }
  }
`;

const UPDATE_EMAIL_MARKETING_MUTATION = `#graphql
  mutation customerEmailMarketingConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
    customerEmailMarketingConsentUpdate(input: $input) {
      customer {
        ${CUSTOMER_EMAIL_MARKETING_FRAGMENT}
      }
      userErrors {
        field
        message
      }
    }
  }
`;

function toCustomerGid(id) {
  if (id == null || id === "") return null;
  const raw = String(id).trim();
  if (raw.startsWith("gid://shopify/Customer/")) return raw;
  const numeric = raw.replace(/\D/g, "");
  if (!numeric) return null;
  return `gid://shopify/Customer/${numeric}`;
}

function getShop(request, body = {}) {
  const url = new URL(request.url);
  return (
    body.shop ||
    url.searchParams.get("shop") ||
    request.headers.get("x-shopify-shop-domain")
  );
}

function parseBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "on", "yes", "enable", "enabled"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "off", "no", "disable", "disabled"].includes(normalized)) {
    return false;
  }
  return null;
}

function parseMarketingState(body, url) {
  const rawState =
    body.marketingState ||
    body.state ||
    url.searchParams.get("marketingState") ||
    url.searchParams.get("state");

  if (rawState != null && String(rawState).trim() !== "") {
    const state = String(rawState).trim().toUpperCase();
    if (!ACCEPTED_STATES.has(state)) {
      return {
        error:
          "Invalid marketingState. Use SUBSCRIBED, UNSUBSCRIBED, or PENDING",
      };
    }
    return { marketingState: state };
  }

  const enabledRaw =
    body.enabled ??
    body.subscribed ??
    body.emailUpdates ??
    url.searchParams.get("enabled") ??
    url.searchParams.get("subscribed");

  if (enabledRaw === undefined || enabledRaw === null || enabledRaw === "") {
    return {
      error:
        "Provide enabled (true/false) or marketingState (SUBSCRIBED/UNSUBSCRIBED)",
    };
  }

  const enabled = parseBoolean(enabledRaw);
  if (enabled === null) {
    return { error: "Invalid enabled value. Use true or false" };
  }

  return { marketingState: enabled ? "SUBSCRIBED" : "UNSUBSCRIBED" };
}

function formatEmailMarketing(customer) {
  const emailAddress = customer?.defaultEmailAddress;
  const marketingState = emailAddress?.marketingState || "NOT_SUBSCRIBED";
  return {
    customerId: customer?.id || "",
    email: emailAddress?.emailAddress || "",
    enabled: marketingState === "SUBSCRIBED",
    marketingState,
    marketingOptInLevel: emailAddress?.marketingOptInLevel || "",
    consentUpdatedAt: emailAddress?.marketingUpdatedAt || null,
  };
}

async function requireShopAndCustomer(request, body = {}) {
  const url = new URL(request.url);
  const shop = getShop(request, body);
  const customerId = toCustomerGid(
    body.customerId ||
      body.id ||
      url.searchParams.get("customerId") ||
      url.searchParams.get("id"),
  );

  if (!shop) {
    return {
      error: jsonCors(request, { ok: false, error: "Missing shop" }, 400, METHODS),
    };
  }
  if (!customerId) {
    return {
      error: jsonCors(
        request,
        { ok: false, error: "Missing customerId" },
        400,
        METHODS,
      ),
    };
  }

  const offline = await getOfflineSession(shop);
  if (!offline) {
    return {
      error: jsonCors(
        request,
        { ok: false, error: "Offline token not found" },
        401,
        METHODS,
      ),
    };
  }

  return { shop, customerId, accessToken: offline.accessToken };
}

async function handleGet(request) {
  const auth = await requireShopAndCustomer(request);
  if (auth.error) return auth.error;

  const { data } = await shopifyGraphql(
    auth.shop,
    auth.accessToken,
    GET_EMAIL_MARKETING_QUERY,
    { id: auth.customerId },
  );

  const customer = data?.data?.customer;
  if (!customer) {
    return jsonCors(
      request,
      { ok: false, error: "Customer not found" },
      404,
      METHODS,
    );
  }

  return jsonCors(
    request,
    { ok: true, ...formatEmailMarketing(customer) },
    200,
    METHODS,
  );
}

async function handleUpdate(request) {
  const url = new URL(request.url);
  let body = {};
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      body = await request.json();
    } catch {
      return jsonCors(
        request,
        { ok: false, error: "Invalid JSON body" },
        400,
        METHODS,
      );
    }
  }

  const auth = await requireShopAndCustomer(request, body);
  if (auth.error) return auth.error;

  const parsed = parseMarketingState(body, url);
  if (parsed.error) {
    return jsonCors(request, { ok: false, error: parsed.error }, 400, METHODS);
  }

  const emailMarketingConsent = {
    marketingState: parsed.marketingState,
    consentUpdatedAt: new Date().toISOString(),
  };
  if (parsed.marketingState === "SUBSCRIBED") {
    emailMarketingConsent.marketingOptInLevel = "SINGLE_OPT_IN";
  }

  const { data } = await shopifyGraphql(
    auth.shop,
    auth.accessToken,
    UPDATE_EMAIL_MARKETING_MUTATION,
    {
      input: {
        customerId: auth.customerId,
        emailMarketingConsent,
      },
    },
  );

  const payload = data?.data?.customerEmailMarketingConsentUpdate;
  const userErrors = payload?.userErrors || [];
  if (userErrors.length > 0) {
    return jsonCors(
      request,
      {
        ok: false,
        error: userErrors.map((e) => e.message).join(", "),
        userErrors,
      },
      400,
      METHODS,
    );
  }

  return jsonCors(
    request,
    { ok: true, ...formatEmailMarketing(payload?.customer) },
    200,
    METHODS,
  );
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }

  if (request.method !== "GET") {
    return jsonCors(
      request,
      { ok: false, error: "Method not allowed" },
      405,
      METHODS,
    );
  }

  try {
    return await handleGet(request);
  } catch (error) {
    return jsonCors(
      request,
      {
        ok: false,
        error: error.message || "Failed to load email marketing consent",
      },
      500,
      METHODS,
    );
  }
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }

  if (request.method !== "POST" && request.method !== "PUT") {
    return jsonCors(
      request,
      { ok: false, error: "Method not allowed" },
      405,
      METHODS,
    );
  }

  try {
    return await handleUpdate(request);
  } catch (error) {
    return jsonCors(
      request,
      {
        ok: false,
        error: error.message || "Failed to update email marketing consent",
      },
      500,
      METHODS,
    );
  }
}
