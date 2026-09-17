import crypto from "node:crypto";
import {
  buildWishlistWebhookData,
  resolveShop,
} from "./wishlist-webhook-payload.server";
import { jsonCors, optionsCors } from "./cors.server";
import {
  signWebhookBody,
  subscriptionsForTopic,
  WISHLIST_EVENTS,
} from "./wishlist-webhook-subscriptions.server";
import {
  addProductHandlesForCustomer,
  customerIdString,
  deleteWishlistForCustomer,
  findWishlistByCustomerId,
  normalizeHandles,
  parseHandles,
  removeProductHandlesForCustomer,
  saveWishlistForCustomer,
} from "./wishlist.server";

export const METHODS = "GET, POST, OPTIONS";
export { WISHLIST_EVENTS, resolveShop };

function webhookPayload(event, data) {
  return {
    topic: event,
    event,
    created_at: new Date().toISOString(),
    data,
  };
}

function envUrlsForEvent(event) {
  const specificKey = `WISHLIST_WEBHOOK_${event
    .split("/")[1]
    .toUpperCase()
    .replace(/-/g, "_")}_URL`;
  return [process.env.WISHLIST_WEBHOOK_URL, process.env[specificKey]]
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function emitWishlistWebhook(event, data) {
  const enriched = await buildWishlistWebhookData(data);
  const payload = webhookPayload(event, enriched);
  const rawBody = JSON.stringify(payload);
  const registered = await subscriptionsForTopic(event);
  const envSecret =
    process.env.WISHLIST_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET || "";
  const envUrls = envUrlsForEvent(event).filter(
    (url) => !registered.some((row) => row.address === url),
  );
  const destinations = [
    ...registered,
    ...envUrls.map((address) => ({
      id: crypto.randomUUID(),
      address,
      secret: envSecret,
    })),
  ];
  if (!destinations.length) return payload;

  await Promise.all(
    destinations.map(async (destination) => {
      const hmac = signWebhookBody(rawBody, destination.secret);
      try {
        const response = await fetch(destination.address, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Wishlist-Topic": event,
            "X-Wishlist-Webhook-Id": destination.id || crypto.randomUUID(),
            "X-Wishlist-Triggered-At": payload.created_at,
            ...(hmac ? { "X-Wishlist-Hmac-Sha256": hmac } : {}),
          },
          body: rawBody,
        });
        if (!response.ok) {
          console.error(
            `Wishlist webhook ${event} failed for ${destination.address}: ${response.status}`,
          );
        }
      } catch (error) {
        console.error(
          `Wishlist webhook ${event} failed for ${destination.address}:`,
          error,
        );
      }
    }),
  );

  return payload;
}

function readHandles(body) {
  return normalizeHandles(
    Array.isArray(body.productHandle)
      ? body.productHandle
      : parseHandles(body.productHandle),
  );
}

function ok(event, message, data) {
  return { ok: true, status: 200, event, message, ...data };
}

function fail(status, error) {
  return { ok: false, status, error };
}

export async function handleWishlistCreated(body, { shop } = {}) {
  const customerId = customerIdString(body.customerId);
  const handles = readHandles(body);
  if (!customerId || customerId === "null") return fail(400, "Missing customerId");
  if (!handles.length) return fail(400, "Missing productHandle");

  const existing = await findWishlistByCustomerId(customerId);
  if (existing) {
    return fail(409, "Wishlist already exists. Use wishlist/updated.");
  }

  await saveWishlistForCustomer(customerId, handles.join(","));
  await emitWishlistWebhook(WISHLIST_EVENTS.created, {
    shop,
    customerId,
    handles,
  });
  return ok(WISHLIST_EVENTS.created, "Wishlist created", { customerId, handles });
}

export async function handleWishlistUpdated(body, { shop } = {}) {
  const customerId = customerIdString(body.customerId);
  const handles = readHandles(body);
  if (!customerId || customerId === "null") return fail(400, "Missing customerId");
  if (!handles.length) return fail(400, "Missing productHandle");

  await saveWishlistForCustomer(customerId, handles.join(","));
  await emitWishlistWebhook(WISHLIST_EVENTS.updated, {
    shop,
    customerId,
    handles,
  });
  return ok(WISHLIST_EVENTS.updated, "Wishlist updated", { customerId, handles });
}

export async function handleWishlistCleared(body, { shop } = {}) {
  const customerId = customerIdString(body.customerId);
  if (!customerId || customerId === "null") return fail(400, "Missing customerId");

  await deleteWishlistForCustomer(customerId);
  await emitWishlistWebhook(WISHLIST_EVENTS.cleared, {
    shop,
    customerId,
    handles: [],
  });
  return ok(WISHLIST_EVENTS.cleared, "Wishlist cleared", {
    customerId,
    handles: [],
  });
}

export async function handleWishlistItemAdded(body, { shop } = {}) {
  const customerId = customerIdString(body.customerId);
  const incoming = readHandles(body);
  if (!customerId || customerId === "null") return fail(400, "Missing customerId");
  if (!incoming.length) return fail(400, "Missing productHandle");

  const result = await addProductHandlesForCustomer(customerId, incoming);
  await emitWishlistWebhook(WISHLIST_EVENTS.item_added, {
    shop,
    customerId: result.customerId,
    handles: result.handles,
    added: result.added,
  });
  return ok(WISHLIST_EVENTS.item_added, "Items added", {
    customerId: result.customerId,
    handles: result.handles,
    added: result.added,
  });
}

export async function handleWishlistItemRemoved(body, { shop } = {}) {
  const customerId = customerIdString(body.customerId);
  const incoming = readHandles(body);
  if (!customerId || customerId === "null") return fail(400, "Missing customerId");
  if (!incoming.length) return fail(400, "Missing productHandle");

  const result = await removeProductHandlesForCustomer(customerId, incoming);
  await emitWishlistWebhook(WISHLIST_EVENTS.item_removed, {
    shop,
    customerId: result.customerId,
    handles: result.handles,
    removed: result.removed,
  });
  return ok(WISHLIST_EVENTS.item_removed, "Items removed", {
    customerId: result.customerId,
    handles: result.handles,
    removed: result.removed,
  });
}

const EVENT_HANDLERS = {
  [WISHLIST_EVENTS.created]: handleWishlistCreated,
  [WISHLIST_EVENTS.updated]: handleWishlistUpdated,
  [WISHLIST_EVENTS.cleared]: handleWishlistCleared,
  [WISHLIST_EVENTS.item_added]: handleWishlistItemAdded,
  [WISHLIST_EVENTS.item_removed]: handleWishlistItemRemoved,
};

export function wishlistCustomWebhookRoutes(event) {
  const handler = EVENT_HANDLERS[event];

  return {
    loader({ request }) {
      if (request.method === "OPTIONS") {
        return optionsCors(request, METHODS);
      }
      return jsonCors(
        request,
        {
          ok: true,
          event,
          message: `POST JSON { customerId, productHandle } to ${event}`,
        },
        200,
        METHODS,
      );
    },
    async action({ request }) {
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
        const shop = await resolveShop(request, body);
        const result = await handler(body, { shop });
        const { status, ...data } = result;
        return jsonCors(request, data, status, METHODS);
      } catch (error) {
        console.error(`${event} webhook failed:`, error);
        return jsonCors(
          request,
          { ok: false, error: error.message || "Wishlist webhook failed" },
          500,
          METHODS,
        );
      }
    },
  };
}
