import crypto from "node:crypto";
import db from "./db.server";
import { toIsoDate } from "./wishlist.server";

export const WISHLIST_EVENTS = {
  created: "wishlist/created",
  updated: "wishlist/updated",
  cleared: "wishlist/cleared",
  item_added: "wishlist/item-added",
  item_removed: "wishlist/item-removed",
};

export const ALLOWED_TOPICS = Object.values(WISHLIST_EVENTS);

const COLLECTIONS = ["WishlistWebhook", "wishlistWebhook"];

function webhookModel() {
  const model = db.wishlistWebhook || db.WishlistWebhook || null;
  if (!model) return null;
  if (
    typeof model.findMany !== "function" &&
    typeof model.findFirst !== "function" &&
    typeof model.create !== "function"
  ) {
    return null;
  }
  return model;
}

function documentId(doc) {
  const value = doc?._id ?? doc?.id;
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if (value.$oid) return String(value.$oid);
    if (typeof value.toString === "function") {
      const text = value.toString();
      if (text && text !== "[object Object]") return text;
    }
  }
  return String(value);
}

function extractDocs(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.cursor?.firstBatch)) return result.cursor.firstBatch;
  if (Array.isArray(result?.documents)) return result.documents;
  return null;
}

function mapWebhook(doc) {
  if (!doc) return null;
  return {
    id: documentId(doc),
    topic: doc.topic,
    address: doc.address,
    format: doc.format || "json",
    created_at: toIsoDate(doc.createdAt),
  };
}

async function runOnCollections(buildCommand) {
  let lastError = null;
  for (const collection of COLLECTIONS) {
    try {
      const result = await db.$runCommandRaw(buildCommand(collection));
      const ok = Number(result?.ok);
      if (ok === 1 || result?.n != null || result?.cursor) {
        return result;
      }
    } catch (error) {
      lastError = error;
      console.error(`WishlistWebhook command failed for ${collection}:`, error);
    }
  }
  if (lastError) throw lastError;
  return null;
}

export function normalizeTopic(topic) {
  const raw = String(topic || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/_/g, "-");
  if (!raw) return "";
  if (ALLOWED_TOPICS.includes(raw)) return raw;
  const prefixed = raw.startsWith("wishlist/") ? raw : `wishlist/${raw}`;
  return ALLOWED_TOPICS.includes(prefixed) ? prefixed : "";
}

export function isValidWebhookAddress(address) {
  try {
    const parsed = new URL(String(address || "").trim());
    if (parsed.protocol === "https:") return true;
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}

export async function findWebhookSubscription(topic, address) {
  const model = webhookModel();
  if (model?.findFirst) {
    try {
      return mapWebhook(await model.findFirst({ where: { topic, address } }));
    } catch (error) {
      console.error("Prisma webhook findFirst failed, using raw query:", error);
    }
  }

  const result = await runOnCollections((collection) => ({
    find: collection,
    filter: { topic, address },
    limit: 1,
  }));
  return mapWebhook(extractDocs(result)?.[0]);
}

export async function listWebhookSubscriptions(topic) {
  const filter = topic ? { topic } : {};
  const model = webhookModel();
  if (model?.findMany) {
    try {
      const rows = await model.findMany({
        where: filter,
        orderBy: { createdAt: "desc" },
      });
      return rows.map(mapWebhook).filter(Boolean);
    } catch (error) {
      console.error("Prisma webhook findMany failed, using raw query:", error);
    }
  }

  const result = await runOnCollections((collection) => ({
    find: collection,
    filter,
    sort: { createdAt: -1 },
  }));
  return (extractDocs(result) || []).map(mapWebhook).filter(Boolean);
}

export async function createWebhookSubscription({ topic, address, format = "json" }) {
  const existing = await findWebhookSubscription(topic, address);
  if (existing) return { webhook: existing, created: false };

  const model = webhookModel();
  if (model?.create) {
    try {
      const row = await model.create({
        data: { topic, address, format },
      });
      return { webhook: mapWebhook(row), created: true };
    } catch (error) {
      console.error("Prisma webhook create failed, using raw query:", error);
    }
  }

  await runOnCollections((collection) => ({
    insert: collection,
    documents: [
      {
        topic,
        address,
        format,
        createdAt: { $date: new Date().toISOString() },
      },
    ],
  }));
  const webhook = await findWebhookSubscription(topic, address);
  return { webhook, created: true };
}

export async function deleteWebhookSubscription({ id, topic, address }) {
  const model = webhookModel();
  if (model?.deleteMany) {
    try {
      if (id && /^[a-fA-F0-9]{24}$/.test(id)) {
        return await model.deleteMany({ where: { id } });
      }
      if (topic && address) {
        return await model.deleteMany({ where: { topic, address } });
      }
    } catch (error) {
      console.error("Prisma webhook delete failed, using raw query:", error);
    }
  }

  const filter = {};
  if (id && /^[a-fA-F0-9]{24}$/.test(id)) filter._id = { $oid: id };
  else if (topic && address) {
    filter.topic = topic;
    filter.address = address;
  } else {
    return null;
  }

  return runOnCollections((collection) => ({
    delete: collection,
    deletes: [{ q: filter, limit: 1 }],
  }));
}

export function signingSecret() {
  return (
    process.env.WISHLIST_WEBHOOK_SECRET ||
    process.env.SHOPIFY_API_SECRET ||
    ""
  );
}

export function signWebhookBody(rawBody) {
  const secret = signingSecret();
  if (!secret) return "";
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

export async function addressesForTopic(topic) {
  const wanted = normalizeTopic(topic);
  const rows = await listWebhookSubscriptions();
  return [
    ...new Set(
      rows
        .filter((row) => normalizeTopic(row.topic) === wanted)
        .map((row) => row.address)
        .filter(Boolean),
    ),
  ];
}
