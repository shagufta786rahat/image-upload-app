import { jsonCors, optionsCors } from "../../cors.server";
import {
  customerIdString,
  deleteWishlistForCustomer,
  normalizeHandles,
  parseHandles,
  saveWishlistForCustomer,
} from "../../wishlist.server";

const METHODS = "GET, POST, OPTIONS";

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }

  return jsonCors(
    request,
    { ok: true, message: "Use POST to save or clear a wishlist" },
    200,
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
    const body = await request.json();
    const customerId = customerIdString(body.customerId);
    const actionType = String(body.actionType || "save").toLowerCase();
    const handles = normalizeHandles(
      Array.isArray(body.productHandle)
        ? body.productHandle
        : parseHandles(body.productHandle),
    );

    if (!customerId || customerId === "null") {
      return jsonCors(
        request,
        { ok: false, error: "Missing customerId" },
        400,
        METHODS,
      );
    }

    if (actionType === "remove" || handles.length === 0) {
      await deleteWishlistForCustomer(customerId);
      return jsonCors(
        request,
        { ok: true, message: "Wishlist cleared", handles: [] },
        200,
        METHODS,
      );
    }

    await saveWishlistForCustomer(customerId, handles.join(","));
    return jsonCors(
      request,
      { ok: true, message: "Wishlist saved", handles },
      200,
      METHODS,
    );
  } catch (error) {
    console.error("Wishlist save error:", error);
    return jsonCors(
      request,
      { ok: false, error: error.message || "Wishlist save failed" },
      500,
      METHODS,
    );
  }
}
