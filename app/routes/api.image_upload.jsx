import { jsonCors, optionsCors } from "../cors.server";
import { getOfflineSession } from "../shopify-api.server";
import {
  MAX_FILE_BYTES,
  uploadShopifyFile,
} from "../shopify-file-upload.server";

const METHODS = "GET, POST, OPTIONS";

async function handleUpload(request) {
  const url = new URL(request.url);
  const shop =
    url.searchParams.get("shop") ||
    request.headers.get("x-shopify-shop-domain");

  if (!shop) {
    return jsonCors(request, { ok: false, error: "Missing shop" }, 400, METHODS);
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

  const formData = await request.formData();
  const file = formData.get("file");

  if (!file || typeof file === "string") {
    return jsonCors(
      request,
      { ok: false, error: "Invalid file upload" },
      400,
      METHODS,
    );
  }

  if (file.size > MAX_FILE_BYTES) {
    return jsonCors(
      request,
      { ok: false, error: "File is too large (max 20 MB)" },
      400,
      METHODS,
    );
  }

  const result = await uploadShopifyFile(shop, offline.accessToken, file);

  return jsonCors(request, result, 200, METHODS);
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }
  return jsonCors(
    request,
    { ok: false, error: "Use POST to upload a file" },
    405,
    METHODS,
  );
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }
  if (request.method !== "POST") {
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
      { ok: false, error: error.message || "Upload failed" },
      500,
      METHODS,
    );
  }
}
