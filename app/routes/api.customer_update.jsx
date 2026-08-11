import prisma from "../db.server";

const METAFIELD_NAMESPACE = "custom";

const CUSTOM_METAFIELD_KEYS = {
  dateOfBirth: "date_of_birth",
  gender: "gender",
  socialMediaHandle: "social_media_handle",
};

const METAFIELD_TYPES = {
  date_of_birth: "single_line_text_field",
  gender: "single_line_text_field",
  social_media_handle: "single_line_text_field",
};

const CUSTOMER_FIELDS_FRAGMENT = `
  id
  firstName
  lastName
  updatedAt
  defaultEmailAddress {
    emailAddress
  }
  defaultPhoneNumber {
    phoneNumber
  }
  dateOfBirth: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "date_of_birth") {
    value
  }
  gender: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "gender") {
    value
  }
  socialMediaHandle: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "social_media_handle") {
    value
  }
`;

const CUSTOMER_UPDATE_MUTATION = `#graphql
  mutation customerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer {
        ${CUSTOMER_FIELDS_FRAGMENT}
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CUSTOMER_QUERY = `#graphql
  query CustomerDetails($id: ID!) {
    customer(id: $id) {
      ${CUSTOMER_FIELDS_FRAGMENT}
    }
  }
`;

const json = (data, status = 200, corsOrigin = "*") =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });

function getCorsOrigin(request) {
  return request.headers.get("origin") || "*";
}

function toCustomerGid(id) {
  if (id == null || id === "") return null;
  const raw = String(id).trim();
  if (raw.startsWith("gid://shopify/Customer/")) return raw;
  const numeric = raw.replace(/\D/g, "");
  if (!numeric) return null;
  return `gid://shopify/Customer/${numeric}`;
}

/** Shopify expects E.164-style phone (e.g. +15551234567). */
function normalizePhone(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return "";

  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  return `+${digits}`;
}

function normalizeEmail(value) {
  if (value == null) return null;
  return String(value).trim();
}

function formatCustomer(customer) {
  if (!customer) return null;
  return {
    id: customer.id,
    firstName: customer.firstName || "",
    lastName: customer.lastName || "",
    updatedAt: customer.updatedAt || null,
    email: customer.defaultEmailAddress?.emailAddress || "",
    phone: customer.defaultPhoneNumber?.phoneNumber || "",
    customDetails: {
      dateOfBirth: customer.dateOfBirth?.value || "",
      gender: customer.gender?.value || "",
      socialMediaHandle: customer.socialMediaHandle?.value || "",
    },
  };
}

async function refreshOfflineToken(session) {
  const response = await fetch(
    `https://${session.shop}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
      }),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }

  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  const refreshExpiresAt = data.refresh_token_expires_in
    ? new Date(Date.now() + data.refresh_token_expires_in * 1000)
    : null;

  await prisma.session.update({
    where: { id: session.id },
    data: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || session.refreshToken,
      expires: expiresAt,
      refreshTokenExpires: refreshExpiresAt || session.refreshTokenExpires,
    },
  });

  return data.access_token;
}

async function shopifyGraphql(shop, accessToken, query, variables) {
  let res = await fetch(`https://${shop}/admin/api/2026-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401) {
    const session = await prisma.session.findFirst({
      where: { shop, isOnline: false },
    });
    if (!session?.refreshToken) {
      throw new Error("Unauthorized and no refresh token available");
    }
    const newToken = await refreshOfflineToken(session);
    res = await fetch(`https://${shop}/admin/api/2026-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": newToken,
      },
      body: JSON.stringify({ query, variables }),
    });
    accessToken = newToken;
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      data?.errors?.[0]?.message || `Shopify API error (${res.status})`,
    );
  }

  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    throw new Error(data.errors[0]?.message || "Shopify GraphQL error");
  }

  return { data, accessToken };
}

async function getOfflineSession(shop) {
  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false },
  });

  if (!session?.accessToken) {
    return null;
  }

  let accessToken = session.accessToken;
  if (
    session.expires &&
    new Date(session.expires).getTime() < Date.now() + 5 * 60 * 1000
  ) {
    accessToken = await refreshOfflineToken(session);
  }

  return { session, accessToken };
}

function buildMetafields(body) {
  const metafields = [];

  for (const [bodyKey, metafieldKey] of Object.entries(CUSTOM_METAFIELD_KEYS)) {
    if (body[bodyKey] === undefined && body[metafieldKey] === undefined) {
      continue;
    }
    const value = body[bodyKey] ?? body[metafieldKey];
    if (value === null || value === undefined) continue;

    const trimmed = String(value).trim();
    if (!trimmed) continue;

    metafields.push({
      namespace: METAFIELD_NAMESPACE,
      key: metafieldKey,
      type: METAFIELD_TYPES[metafieldKey],
      value: trimmed,
    });
  }

  return metafields;
}

async function handleGetCustomer(request) {
  const corsOrigin = getCorsOrigin(request);
  const url = new URL(request.url);
  const shop =
    url.searchParams.get("shop") ||
    request.headers.get("x-shopify-shop-domain");
  const customerId = toCustomerGid(
    url.searchParams.get("customerId") || url.searchParams.get("id"),
  );

  if (!shop) {
    return json({ ok: false, error: "Missing shop" }, 400, corsOrigin);
  }
  if (!customerId) {
    return json({ ok: false, error: "Missing customerId" }, 400, corsOrigin);
  }

  const offline = await getOfflineSession(shop);
  if (!offline) {
    return json(
      { ok: false, error: "Offline token not found" },
      401,
      corsOrigin,
    );
  }

  const { data } = await shopifyGraphql(
    shop,
    offline.accessToken,
    CUSTOMER_QUERY,
    { id: customerId },
  );

  const customer = data?.data?.customer;
  if (!customer) {
    return json({ ok: false, error: "Customer not found" }, 404, corsOrigin);
  }

  return json({ ok: true, customer: formatCustomer(customer) }, 200, corsOrigin);
}

async function handleUpdateCustomer(request) {
  const corsOrigin = getCorsOrigin(request);
  const url = new URL(request.url);
  const shop =
    url.searchParams.get("shop") ||
    request.headers.get("x-shopify-shop-domain");

  if (!shop) {
    return json({ ok: false, error: "Missing shop" }, 400, corsOrigin);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body" }, 400, corsOrigin);
  }

  const customerId = toCustomerGid(
    body.customerId || body.id || url.searchParams.get("customerId"),
  );
  if (!customerId) {
    return json({ ok: false, error: "Missing customerId" }, 400, corsOrigin);
  }

  const offline = await getOfflineSession(shop);
  if (!offline) {
    return json(
      { ok: false, error: "Offline token not found" },
      401,
      corsOrigin,
    );
  }

  const input = { id: customerId };

  if (body.firstName !== undefined) {
    input.firstName = String(body.firstName ?? "").trim();
  }
  if (body.lastName !== undefined) {
    input.lastName = String(body.lastName ?? "").trim();
  }

  const emailRaw = body.email ?? body.emailAddress;
  if (emailRaw !== undefined) {
    const email = normalizeEmail(emailRaw);
    if (email) {
      input.email = email;
    }
  }

  const phoneRaw = body.phone ?? body.phoneNumber;
  if (phoneRaw !== undefined) {
    const phone = normalizePhone(phoneRaw);
    if (phone === null) {
      return json(
        {
          ok: false,
          error: "Invalid phone number. Use a valid number like +15551234567",
        },
        400,
        corsOrigin,
      );
    }
    if (phone) {
      input.phone = phone;
    }
  }

  const metafields = buildMetafields(body);
  if (metafields.length > 0) {
    input.metafields = metafields;
  }

  if (
    input.firstName === undefined &&
    input.lastName === undefined &&
    input.email === undefined &&
    input.phone === undefined &&
    !input.metafields
  ) {
    return json(
      {
        ok: false,
        error:
          "Provide at least one field to update: firstName, lastName, phone, email, dateOfBirth, gender, socialMediaHandle",
      },
      400,
      corsOrigin,
    );
  }

  const { data } = await shopifyGraphql(
    shop,
    offline.accessToken,
    CUSTOMER_UPDATE_MUTATION,
    { input },
  );

  const payload = data?.data?.customerUpdate;
  const userErrors = payload?.userErrors || [];
  if (userErrors.length > 0) {
    return json(
      {
        ok: false,
        error: userErrors.map((e) => e.message).join(", "),
        userErrors,
      },
      400,
      corsOrigin,
    );
  }

  return json(
    {
      ok: true,
      customer: formatCustomer(payload?.customer),
    },
    200,
    corsOrigin,
  );
}

export async function loader({ request }) {
  const corsOrigin = getCorsOrigin(request);

  if (request.method === "OPTIONS") {
    return json({ ok: true }, 204, corsOrigin);
  }

  if (request.method !== "GET") {
    return json({ ok: false, error: "Method not allowed" }, 405, corsOrigin);
  }

  try {
    return await handleGetCustomer(request);
  } catch (error) {
    return json(
      { ok: false, error: error.message || "Failed to load customer" },
      500,
      corsOrigin,
    );
  }
}

export async function action({ request }) {
  const corsOrigin = getCorsOrigin(request);

  if (request.method === "OPTIONS") {
    return json({ ok: true }, 204, corsOrigin);
  }

  if (request.method !== "POST" && request.method !== "PUT") {
    return json({ ok: false, error: "Method not allowed" }, 405, corsOrigin);
  }

  try {
    return await handleUpdateCustomer(request);
  } catch (error) {
    return json(
      { ok: false, error: error.message || "Failed to update customer" },
      500,
      corsOrigin,
    );
  }
}
