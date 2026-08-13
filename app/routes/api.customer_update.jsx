import { jsonCors, optionsCors } from "../cors.server";
import { getOfflineSession, shopifyGraphql } from "../shopify-api.server";

const METAFIELD_NAMESPACE = "eshop";
const METHODS = "GET, POST, PUT, OPTIONS";

const CUSTOM_METAFIELD_KEYS = {
  dateOfBirth: "date_of_birth",
  gender: "gender",
  socialMediaHandle: "social_media_handle",
};

const METAFIELD_TYPES = {
  date_of_birth: "single_line_text_field",
  gender: "single_line_text_field",
  social_media_handle: "single_line_text_field",
  profile_picture: "file_reference",
};

const CUSTOMER_FIELDS_FRAGMENT = `
  id
  firstName
  lastName
  updatedAt
  defaultEmailAddress {
    emailAddress
    marketingState
    marketingOptInLevel
    marketingUpdatedAt
  }
  defaultPhoneNumber {
    phoneNumber
    marketingState
    marketingOptInLevel
    marketingUpdatedAt
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
  profilePicture: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "profile_picture") {
    type
    value
    reference {
      ... on MediaImage {
        id
        image {
          url
          altText
        }
      }
      ... on GenericFile {
        id
        url
      }
    }
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

function toCustomerGid(id) {
  if (id == null || id === "") return null;
  const raw = String(id).trim();
  if (raw.startsWith("gid://shopify/Customer/")) return raw;
  const numeric = raw.replace(/\D/g, "");
  if (!numeric) return null;
  return `gid://shopify/Customer/${numeric}`;
}

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

function toFileGid(id) {
  if (id == null || id === "") return null;
  const raw = String(id).trim();
  if (raw.startsWith("gid://shopify/")) return raw;
  return null;
}

function getProfilePictureUrl(metafield) {
  if (!metafield?.reference) return "";
  return metafield.reference.image?.url || metafield.reference.url || "";
}

function formatMarketing(contact) {
  const marketingState = contact?.marketingState || "NOT_SUBSCRIBED";
  return {
    enabled: marketingState === "SUBSCRIBED",
    marketingState,
    marketingOptInLevel: contact?.marketingOptInLevel || "",
    consentUpdatedAt: contact?.marketingUpdatedAt || null,
  };
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
    emailMarketing: formatMarketing(customer.defaultEmailAddress),
    smsMarketing: formatMarketing(customer.defaultPhoneNumber),
    customDetails: {
      dateOfBirth: customer.dateOfBirth?.value || "",
      gender: customer.gender?.value || "",
      socialMediaHandle: customer.socialMediaHandle?.value || "",
      profilePicture: {
        fileId:
          customer.profilePicture?.value ||
          customer.profilePicture?.reference?.id ||
          "",
        url: getProfilePictureUrl(customer.profilePicture),
      },
    },
  };
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

  const profileRaw =
    body.profilePicture ??
    body.profilePictureFileId ??
    body.profile_picture ??
    body.fileId;

  if (profileRaw !== undefined && profileRaw !== null && profileRaw !== "") {
    const fileGid = toFileGid(profileRaw);
    if (!fileGid) {
      throw new Error(
        "Invalid profilePicture fileId. Use /api/customer_profile_picture to upload, or pass a Shopify file GID",
      );
    }
    metafields.push({
      namespace: METAFIELD_NAMESPACE,
      key: "profile_picture",
      type: METAFIELD_TYPES.profile_picture,
      value: fileGid,
    });
  }

  return metafields;
}

async function handleGetCustomer(request) {
  const url = new URL(request.url);
  const shop =
    url.searchParams.get("shop") ||
    request.headers.get("x-shopify-shop-domain");
  const customerId = toCustomerGid(
    url.searchParams.get("customerId") || url.searchParams.get("id"),
  );

  if (!shop) {
    return jsonCors(request, { ok: false, error: "Missing shop" }, 400, METHODS);
  }
  if (!customerId) {
    return jsonCors(
      request,
      { ok: false, error: "Missing customerId" },
      400,
      METHODS,
    );
  }

  const offline = await getOfflineSession(shop);
  if (!offline) {
    return jsonCors(
      request,
      { ok: false, error: "Offline token not found" },
      401,
      METHODS,
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
    return jsonCors(
      request,
      { ok: false, error: "Customer not found" },
      404,
      METHODS,
    );
  }

  return jsonCors(
    request,
    { ok: true, customer: formatCustomer(customer) },
    200,
    METHODS,
  );
}

async function handleUpdateCustomer(request) {
  const url = new URL(request.url);
  const shop =
    url.searchParams.get("shop") ||
    request.headers.get("x-shopify-shop-domain");

  if (!shop) {
    return jsonCors(request, { ok: false, error: "Missing shop" }, 400, METHODS);
  }

  let body;
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

  const customerId = toCustomerGid(
    body.customerId || body.id || url.searchParams.get("customerId"),
  );
  if (!customerId) {
    return jsonCors(
      request,
      { ok: false, error: "Missing customerId" },
      400,
      METHODS,
    );
  }

  const offline = await getOfflineSession(shop);
  if (!offline) {
    return jsonCors(
      request,
      { ok: false, error: "Offline token not found" },
      401,
      METHODS,
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
      return jsonCors(
        request,
        {
          ok: false,
          error: "Invalid phone number. Use a valid number like +15551234567",
        },
        400,
        METHODS,
      );
    }
    if (phone) {
      input.phone = phone;
    }
  }

  let metafields;
  try {
    metafields = buildMetafields(body);
  } catch (error) {
    return jsonCors(
      request,
      { ok: false, error: error.message },
      400,
      METHODS,
    );
  }

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
    return jsonCors(
      request,
      {
        ok: false,
        error:
          "Provide at least one field to update: firstName, lastName, phone, email, dateOfBirth, gender, socialMediaHandle",
      },
      400,
      METHODS,
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
    {
      ok: true,
      customer: formatCustomer(payload?.customer),
    },
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
    return await handleGetCustomer(request);
  } catch (error) {
    return jsonCors(
      request,
      { ok: false, error: error.message || "Failed to load customer" },
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
    return await handleUpdateCustomer(request);
  } catch (error) {
    return jsonCors(
      request,
      { ok: false, error: error.message || "Failed to update customer" },
      500,
      METHODS,
    );
  }
}
