import { jsonCors, optionsCors } from "../cors.server";
import { getOfflineSession, shopifyGraphql } from "../shopify-api.server";
import { uploadShopifyFile } from "../shopify-file-upload.server";

const METAFIELD_NAMESPACE = "eshop";
const PROFILE_PICTURE_KEY = "profile_picture";
const METHODS = "GET, POST, PUT, OPTIONS";

const PROFILE_PICTURE_FRAGMENT = `
  profilePicture: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "${PROFILE_PICTURE_KEY}") {
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

const SET_PROFILE_PICTURE_MUTATION = `#graphql
  mutation setCustomerProfilePicture($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer {
        id
        firstName
        lastName
        ${PROFILE_PICTURE_FRAGMENT}
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const GET_PROFILE_PICTURE_QUERY = `#graphql
  query CustomerProfilePicture($id: ID!) {
    customer(id: $id) {
      id
      firstName
      lastName
      ${PROFILE_PICTURE_FRAGMENT}
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

function toFileGid(id) {
  if (id == null || id === "") return null;
  const raw = String(id).trim();
  if (raw.startsWith("gid://shopify/")) return raw;
  return null;
}

function formatProfilePicture(customer) {
  const metafield = customer?.profilePicture;
  const reference = metafield?.reference;
  return {
    customerId: customer?.id || "",
    firstName: customer?.firstName || "",
    lastName: customer?.lastName || "",
    profilePicture: {
      fileId: metafield?.value || reference?.id || "",
      url: reference?.image?.url || reference?.url || "",
    },
  };
}

/** Upload via shared Shopify Files helper (no internal HTTP roundtrip). */
async function uploadProfileImage(shop, accessToken, file) {
  const data = await uploadShopifyFile(shop, accessToken, file);
  if (!data.fileId) {
    throw new Error("Image upload did not return fileId");
  }
  return {
    fileId: data.fileId,
    url: data.url || "",
    filename: data.filename || file.name || "",
  };
}

async function setProfilePictureMetafield(shop, accessToken, customerId, fileId) {
  const { data } = await shopifyGraphql(
    shop,
    accessToken,
    SET_PROFILE_PICTURE_MUTATION,
    {
      input: {
        id: customerId,
        metafields: [
          {
            namespace: METAFIELD_NAMESPACE,
            key: PROFILE_PICTURE_KEY,
            type: "file_reference",
            value: fileId,
          },
        ],
      },
    },
  );

  const payload = data?.data?.customerUpdate;
  const userErrors = payload?.userErrors || [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join(", "));
  }

  return payload?.customer;
}

async function handleGet(request) {
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
    GET_PROFILE_PICTURE_QUERY,
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
    { ok: true, ...formatProfilePicture(customer) },
    200,
    METHODS,
  );
}

async function handleUpload(request) {
  const url = new URL(request.url);
  const shop =
    url.searchParams.get("shop") ||
    request.headers.get("x-shopify-shop-domain");

  if (!shop) {
    return jsonCors(request, { ok: false, error: "Missing shop" }, 400, METHODS);
  }

  const contentType = request.headers.get("content-type") || "";
  let customerId = toCustomerGid(url.searchParams.get("customerId"));
  let file = null;
  let existingFileId = null;

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    customerId = toCustomerGid(
      formData.get("customerId") || formData.get("id") || customerId,
    );
    const rawFile =
      formData.get("profilePicture") ||
      formData.get("profile_picture") ||
      formData.get("file");
    file = rawFile && typeof rawFile !== "string" ? rawFile : null;
    existingFileId = toFileGid(
      formData.get("fileId") || formData.get("profilePictureFileId"),
    );
  } else {
    const body = await request.json();
    customerId = toCustomerGid(body.customerId || body.id || customerId);
    existingFileId = toFileGid(
      body.fileId || body.profilePicture || body.profilePictureFileId,
    );
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

  let uploaded = null;
  let fileId = existingFileId;

  if (file) {
    uploaded = await uploadProfileImage(shop, offline.accessToken, file);
    fileId = uploaded.fileId;
  }

  if (!fileId) {
    return jsonCors(
      request,
      {
        ok: false,
        error:
          "Provide an image file (FormData field: profilePicture/file) or an existing fileId",
      },
      400,
      METHODS,
    );
  }

  const customer = await setProfilePictureMetafield(
    shop,
    offline.accessToken,
    customerId,
    fileId,
  );

  const result = formatProfilePicture(customer);
  if (uploaded?.url && !result.profilePicture.url) {
    result.profilePicture.url = uploaded.url;
  }
  if (uploaded?.fileId) {
    result.profilePicture.fileId = uploaded.fileId;
  }

  return jsonCors(
    request,
    {
      ok: true,
      ...result,
      uploaded: uploaded || undefined,
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
    return await handleGet(request);
  } catch (error) {
    return jsonCors(
      request,
      { ok: false, error: error.message || "Failed to load profile picture" },
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
    return await handleUpload(request);
  } catch (error) {
    return jsonCors(
      request,
      {
        ok: false,
        error: error.message || "Failed to update profile picture",
      },
      500,
      METHODS,
    );
  }
}
