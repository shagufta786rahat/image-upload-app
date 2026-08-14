import { jsonCors, optionsCors } from "../../cors.server";
import {
  customerIdString,
  findWishlistByCustomerId,
  parseHandles,
} from "../../wishlist.server";

const METHODS = "GET, OPTIONS";

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }

  try {
    const url = new URL(request.url);
    const customerId = customerIdString(url.searchParams.get("customerId"));

    if (!customerId || customerId === "null") {
      return jsonCors(request, { ok: true, handles: [] }, 200, METHODS);
    }

    const row = await findWishlistByCustomerId(customerId);
    const handles = parseHandles(row?.productHandle);

    return jsonCors(request, { ok: true, handles }, 200, METHODS);
  } catch (error) {
    console.error("Wishlist list error:", error);
    return jsonCors(
      request,
      { ok: false, error: error.message || "Wishlist list failed", handles: [] },
      500,
      METHODS,
    );
  }
}
