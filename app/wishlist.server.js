import db from "./db.server";

const COLLECTIONS = ["Wishlist", "wishlist"];

export function parseHandles(productHandle) {
  const raw = String(productHandle || "").trim();
  if (!raw) return [];

  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return normalizeHandles(parsed);
    } catch {
      // fall through
    }
  }

  return normalizeHandles(raw.split(","));
}

export function normalizeHandles(handles) {
  const seen = new Set();
  const result = [];

  for (const value of handles || []) {
    const handle = String(value || "").trim();
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    result.push(handle);
  }

  return result;
}

export function customerIdString(customerId) {
  return String(customerId || "").trim();
}

export function toIsoDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const date = new Date(Number(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "object") {
    if (value.$date) return toIsoDate(value.$date);
    if (value.$numberLong) return toIsoDate(value.$numberLong);
  }
  return null;
}

function wishlistModel() {
  const model = db.wishlist || db.Wishlist || null;
  if (!model) return null;
  if (
    typeof model.findMany !== "function" &&
    typeof model.findFirst !== "function" &&
    typeof model.count !== "function"
  ) {
    return null;
  }
  return model;
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value && typeof value === "object") {
    if (value.$numberInt != null) return toNumber(value.$numberInt);
    if (value.$numberLong != null) return toNumber(value.$numberLong);
    if (typeof value.low === "number") return value.low;
  }
  return null;
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

function isObjectId(id) {
  return /^[a-fA-F0-9]{24}$/.test(String(id || ""));
}

function mapWishlist(doc) {
  if (!doc) return null;
  return {
    id: documentId(doc),
    customerId: doc.customerId,
    productHandle: doc.productHandle,
    createdAt: toIsoDate(doc.createdAt),
  };
}

function toMongoFilter(where = {}) {
  const filter = {};
  if (where.createdAt?.gte) {
    filter.createdAt = { $gte: where.createdAt.gte };
  }
  if (where.productHandle?.contains) {
    filter.productHandle = {
      $regex: where.productHandle.contains,
      $options: "i",
    };
  }
  if (where.customerId?.in?.length) {
    filter.customerId = { $in: where.customerId.in };
  }
  return filter;
}

function extractDocs(result) {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.cursor?.firstBatch)) return result.cursor.firstBatch;
  if (Array.isArray(result?.documents)) return result.documents;
  return null;
}

function extractCount(result) {
  const direct = toNumber(result?.n);
  if (direct != null) return direct;
  const batch = result?.cursor?.firstBatch;
  if (Array.isArray(batch)) {
    if (batch.length === 0) return 0;
    return toNumber(batch[0]?.n ?? batch[0]?.count);
  }
  return null;
}

async function runOnCollections(buildCommand) {
  let lastError = null;
  for (const collection of COLLECTIONS) {
    try {
      const result = await db.$runCommandRaw(buildCommand(collection));
      const ok = toNumber(result?.ok);
      if (ok === 1 || result?.n != null || result?.cursor) {
        return result;
      }
    } catch (error) {
      lastError = error;
      console.error(`Wishlist command failed for ${collection}:`, error);
    }
  }
  if (lastError) throw lastError;
  return null;
}

export async function findWishlistByCustomerId(customerId) {
  const model = wishlistModel();
  if (model?.findFirst) {
    try {
      const row = await model.findFirst({ where: { customerId } });
      return mapWishlist(row);
    } catch (error) {
      console.error("Prisma wishlist findFirst failed, using raw query:", error);
    }
  }

  const result = await runOnCollections((collection) => ({
    find: collection,
    filter: { customerId },
    limit: 1,
  }));
  return mapWishlist(extractDocs(result)?.[0]);
}

export async function countWishlists(where = {}) {
  const model = wishlistModel();
  if (model?.count) {
    try {
      return await model.count({ where });
    } catch (error) {
      console.error("Prisma wishlist count failed, using raw query:", error);
    }
  }

  const filter = toMongoFilter(where);

  for (const collection of COLLECTIONS) {
    try {
      const counted = await db.$runCommandRaw({
        count: collection,
        query: filter,
      });
      const n = extractCount(counted);
      if (n != null) return n;
    } catch (error) {
      console.error(`Wishlist count failed for ${collection}:`, error);
    }

    try {
      const aggregated = await db.$runCommandRaw({
        aggregate: collection,
        pipeline: [
          ...(Object.keys(filter).length ? [{ $match: filter }] : []),
          { $count: "n" },
        ],
        cursor: {},
      });
      const n = extractCount(aggregated);
      if (n != null) return n;
    } catch (error) {
      console.error(`Wishlist aggregate count failed for ${collection}:`, error);
    }
  }

  const docs = await findWishlists({ where, take: 10000 });
  return docs.length;
}

export async function findWishlists({ skip, take, where = {} } = {}) {
  const model = wishlistModel();
  if (model?.findMany) {
    try {
      const rows = await model.findMany({
        where,
        ...(skip != null ? { skip } : {}),
        ...(take != null ? { take } : {}),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      return rows.map(mapWishlist).filter(Boolean);
    } catch (error) {
      console.error("Prisma wishlist findMany failed, using raw query:", error);
    }
  }

  for (const collection of COLLECTIONS) {
    try {
      const command = {
        find: collection,
        filter: toMongoFilter(where),
        sort: { createdAt: -1, _id: -1 },
      };
      if (skip) command.skip = skip;
      if (take) command.limit = take;
      const result = await db.$runCommandRaw(command);
      const docs = extractDocs(result);
      if (Array.isArray(docs)) return docs.map(mapWishlist).filter(Boolean);
    } catch (error) {
      console.error(`Wishlist find failed for ${collection}:`, error);
    }
  }

  return [];
}

export async function saveWishlistForCustomer(customerId, productHandle) {
  const model = wishlistModel();
  const existing = await findWishlistByCustomerId(customerId);

  if (model?.update && model?.create) {
    try {
      if (isObjectId(existing?.id)) {
        return model.update({
          where: { id: existing.id },
          data: { productHandle },
        });
      }
      return model.create({
        data: { customerId, productHandle },
      });
    } catch (error) {
      console.error("Prisma wishlist save failed, using raw query:", error);
    }
  }

  if (existing) {
    await runOnCollections((collection) => ({
      update: collection,
      updates: [
        {
          q: { customerId },
          u: { $set: { productHandle } },
          multi: true,
        },
      ],
    }));
    return { customerId, productHandle };
  }

  await runOnCollections((collection) => ({
    insert: collection,
    documents: [
      {
        customerId,
        productHandle,
        createdAt: { $date: new Date().toISOString() },
      },
    ],
  }));
  return { customerId, productHandle };
}

export async function deleteWishlistForCustomer(customerId) {
  const model = wishlistModel();
  if (model?.deleteMany) {
    try {
      return await model.deleteMany({ where: { customerId } });
    } catch (error) {
      console.error("Prisma wishlist delete failed, using raw query:", error);
    }
  }

  return runOnCollections((collection) => ({
    delete: collection,
    deletes: [{ q: { customerId }, limit: 0 }],
  }));
}
