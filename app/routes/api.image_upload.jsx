import prisma from "../db.server";

const json = (data, status = 200, corsOrigin = "*") =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_FILE_BYTES = 20 * 1024 * 1024;

function getCorsOrigin(request) {
  return request.headers.get("origin") || "*";
}

function isImageMime(mimeType) {
  return String(mimeType || "").toLowerCase().startsWith("image/");
}

async function shopifyGraphql(shop, accessToken, query, variables) {
  console.log(accessToken,"--accessToken--");
  console.log(shop,"--shop--");
  const res = await fetch(`https://${shop}/admin/api/2026-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.errors?.[0]?.message || `Shopify API error (${res.status}) (${accessToken})`);
  }
  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    throw new Error(data.errors[0]?.message || "Shopify GraphQL error");
  }
  return data;
}

async function createStagedUpload(shop, accessToken, filename, mimeType) {
  const image = isImageMime(mimeType);
  const resource = image ? "IMAGE" : "FILE";

  const data = await shopifyGraphql(
    shop,
    accessToken,
    `
      mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
        stagedUploadsCreate(input: $input) {
          stagedTargets {
            url
            resourceUrl
            parameters {
              name
              value
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      input: [
        {
          filename,
          mimeType,
          resource,
          httpMethod: "POST",
        },
      ],
    },
  );

  const userErrors = data?.data?.stagedUploadsCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join(", "));
  }

  const target = data?.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl) {
    throw new Error("Failed to create staged upload target");
  }

  return { target, contentType: image ? "IMAGE" : "FILE" };
}

async function uploadToStagedTarget(target, file, filename, mimeType) {
  const arrayBuffer = await file.arrayBuffer();
  const blob = new Blob([arrayBuffer], { type: mimeType });
  const uploadForm = new FormData();

  (target.parameters || []).forEach((param) => {
    uploadForm.append(param.name, param.value);
  });
  uploadForm.append("file", blob, filename);

  const res = await fetch(target.url, {
    method: "POST",
    body: uploadForm,
  });

  if (!res.ok) {
    throw new Error(`Staged upload failed (${res.status})`);
  }
}

async function createShopifyFile(shop, accessToken, resourceUrl, contentType) {
  const data = await shopifyGraphql(
    shop,
    accessToken,
    `
      mutation fileCreate($files: [FileCreateInput!]!) {
        fileCreate(files: $files) {
          files {
            id
            fileStatus
            ... on MediaImage {
              image {
                url
              }
            }
            ... on GenericFile {
              url
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      files: [
        {
          originalSource: resourceUrl,
          contentType,
        },
      ],
    },
  );

  const userErrors = data?.data?.fileCreate?.userErrors ?? [];
  if (userErrors.length > 0) {
    throw new Error(userErrors.map((e) => e.message).join(", "));
  }

  const created = data?.data?.fileCreate?.files?.[0];
  if (!created?.id) {
    throw new Error("File was not created in Shopify");
  }

  return created;
}

async function resolveFileCdnUrl(shop, accessToken, fileId, initialFile) {
  const immediateUrl = initialFile?.image?.url || initialFile?.url || null;
  if (immediateUrl) return immediateUrl;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const data = await shopifyGraphql(
      shop,
      accessToken,
      `
        query getCpoFileUrl($id: ID!) {
          node(id: $id) {
            ... on MediaImage {
              fileStatus
              image {
                url
              }
            }
            ... on GenericFile {
              fileStatus
              url
            }
          }
        }
      `,
      { id: fileId },
    );

    const node = data?.data?.node;
    const url = node?.image?.url || node?.url || null;
    if (url) return url;

    if (node?.fileStatus === "FAILED") {
      throw new Error("Shopify file processing failed");
    }

    await sleep(500);
  }

  throw new Error("CDN URL not ready yet. Please try again.");
}

async function handleUpload(request) {
  const corsOrigin = getCorsOrigin(request);
  const url = new URL(request.url);
  const shop =
    url.searchParams.get("shop") ||
    request.headers.get("x-shopify-shop-domain");

  if (!shop) {
    return json({ ok: false, error: "Missing shop" }, 400, corsOrigin);
  }

  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false },
  });

  if (!session?.accessToken) {
    return json({ ok: false, error: "Offline token not found" }, 401, corsOrigin);
  }

  const formData = await request.formData();
  const file = formData.get("file");

  if (!file || typeof file === "string") {
    return json({ ok: false, error: "Invalid file upload" }, 400, corsOrigin);
  }

  if (file.size > MAX_FILE_BYTES) {
    return json(
      { ok: false, error: "File is too large (max 20 MB)" },
      400,
      corsOrigin,
    );
  }

  const filename = file.name || (isImageMime(file.type) ? "upload.jpg" : "upload.bin");
  const mimeType = file.type || (isImageMime(filename) ? "image/jpeg" : "application/octet-stream");

  const { target, contentType } = await createStagedUpload(
    shop,
    session.accessToken,
    filename,
    mimeType,
  );

  await uploadToStagedTarget(target, file, filename, mimeType);

  const created = await createShopifyFile(
    shop,
    session.accessToken,
    target.resourceUrl,
    contentType,
  );

  const cdnUrl = await resolveFileCdnUrl(
    shop,
    session.accessToken,
    created.id,
    created,
  );

  return json(
    {
      ok: true,
      url: cdnUrl,
      fileId: created.id,
      filename,
      mimeType,
      contentType,
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
  return json({ ok: false, error: "Use POST to upload a file" }, 405, corsOrigin);
}

export async function action({ request }) {
  const corsOrigin = getCorsOrigin(request);
  if (request.method === "OPTIONS") {
    return json({ ok: true }, 204, corsOrigin);
  }
  if (request.method !== "POST") {
    return json({ ok: false, error: "Method not allowed" }, 405, corsOrigin);
  }

  try {
    return await handleUpload(request);
  } catch (error) {
    return json(
      { ok: false, error: error.message || "Upload failed" },
      500,
      corsOrigin,
    );
  }
}