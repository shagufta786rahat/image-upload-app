import { jsonCors, optionsCors } from "../../cors.server";
import {
  ALLOWED_TOPICS,
  createWebhookSubscription,
  deleteWebhookSubscription,
  isValidWebhookAddress,
  listWebhookSubscriptions,
  normalizeTopic,
} from "../../wishlist-webhook-subscriptions.server";

const METHODS = "GET, POST, DELETE, OPTIONS";

function readWebhookInput(body = {}) {
  const source = body.webhook && typeof body.webhook === "object" ? body.webhook : body;
  return {
    id: String(source.id || body.id || "").trim(),
    topic: normalizeTopic(source.topic || source.event),
    address: String(source.address || source.url || source.uri || "").trim(),
    format: String(source.format || "json").trim().toLowerCase() || "json",
  };
}

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }

  try {
    const url = new URL(request.url);
    const topic = normalizeTopic(url.searchParams.get("topic"));
    let webhooks = await listWebhookSubscriptions();
    webhooks = webhooks.map((webhook) => ({
      ...webhook,
      topic: normalizeTopic(webhook.topic) || webhook.topic,
    }));
    if (topic) {
      webhooks = webhooks.filter((webhook) => webhook.topic === topic);
    }
    return jsonCors(
      request,
      { ok: true, topics: ALLOWED_TOPICS, webhooks },
      200,
      METHODS,
    );
  } catch (error) {
    console.error("List wishlist webhooks failed:", error);
    return jsonCors(
      request,
      { ok: false, error: error.message || "Could not list webhooks" },
      500,
      METHODS,
    );
  }
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }

  if (request.method === "DELETE") {
    try {
      const url = new URL(request.url);
      let body = {};
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        body = await request.json().catch(() => ({}));
      }
      const input = readWebhookInput({
        ...body,
        id: body.id || url.searchParams.get("id"),
        topic: body.topic || url.searchParams.get("topic"),
        address: body.address || url.searchParams.get("address"),
      });

      if (!input.id && (!input.topic || !input.address)) {
        return jsonCors(
          request,
          { ok: false, error: "Pass id, or topic and address" },
          400,
          METHODS,
        );
      }

      await deleteWebhookSubscription(input);
      return jsonCors(request, { ok: true, message: "Webhook deleted" }, 200, METHODS);
    } catch (error) {
      console.error("Delete wishlist webhook failed:", error);
      return jsonCors(
        request,
        { ok: false, error: error.message || "Could not delete webhook" },
        500,
        METHODS,
      );
    }
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
    const input = readWebhookInput(body);

    if (!input.topic) {
      return jsonCors(
        request,
        {
          ok: false,
          error: "Invalid topic",
          topics: ALLOWED_TOPICS,
        },
        400,
        METHODS,
      );
    }

    if (!isValidWebhookAddress(input.address)) {
      return jsonCors(
        request,
        {
          ok: false,
          error: "address must be https://, or http://localhost",
        },
        400,
        METHODS,
      );
    }

    if (input.format !== "json") {
      return jsonCors(
        request,
        { ok: false, error: "Only format=json is supported" },
        400,
        METHODS,
      );
    }

    const { webhook, created } = await createWebhookSubscription(input);
    return jsonCors(
      request,
      {
        ok: true,
        created,
        webhook,
      },
      created ? 201 : 200,
      METHODS,
    );
  } catch (error) {
    console.error("Register wishlist webhook failed:", error);
    return jsonCors(
      request,
      { ok: false, error: error.message || "Could not register webhook" },
      500,
      METHODS,
    );
  }
}
