import db from "./db.server";

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

function wishlistModel() {
  return db.wishlist || db.Wishlist || null;
}

function mapRawDoc(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id || doc.id || ""),
    customerId: doc.customerId,
    productHandle: doc.productHandle,
    createdAt: doc.createdAt,
  };
}

async function runOnCollections(buildCommand) {
  let lastError = null;
  for (const collection of ["Wishlist", "wishlist"]) {
    try {
      const result = await db.$runCommandRaw(buildCommand(collection));
      if (result?.ok === 1 || result?.n != null || result?.cursor) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

export async function findWishlistByCustomerId(customerId) {
  const model = wishlistModel();
  if (model?.findFirst) {
    return model.findFirst({ where: { customerId } });
  }

  const result = await runOnCollections((collection) => ({
    find: collection,
    filter: { customerId },
    limit: 1,
  }));
  const doc = result?.cursor?.firstBatch?.[0];
  return mapRawDoc(doc);
}

export async function saveWishlistForCustomer(customerId, productHandle) {
  const model = wishlistModel();
  const existing = await findWishlistByCustomerId(customerId);

  if (model?.update && model?.create) {
    if (existing?.id) {
      return model.update({
        where: { id: existing.id },
        data: { productHandle },
      });
    }
    return model.create({
      data: { customerId, productHandle },
    });
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
    return model.deleteMany({ where: { customerId } });
  }

  return runOnCollections((collection) => ({
    delete: collection,
    deletes: [{ q: { customerId }, limit: 0 }],
  }));
}
