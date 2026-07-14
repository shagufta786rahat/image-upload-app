import prisma from "../db.server";

const json = (data, status = 200, corsOrigin = "*") =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });

function getCorsOrigin(request) {
  return request.headers.get("origin") || "*";
}

function toNumericId(gidOrId) {
  if (gidOrId == null) return null;
  const raw = String(gidOrId);
  const match = raw.match(/\/(\d+)$/);
  if (match) return Number(match[1]);
  const asNum = Number(raw);
  return Number.isFinite(asNum) ? asNum : null;
}

function parseFieldValue(field) {
  if (!field) return null;
  if (field.jsonValue !== undefined && field.jsonValue !== null) {
    return field.jsonValue;
  }
  const raw = field.value;
  if (raw == null || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function fieldMap(fields = []) {
  const map = {};
  for (const field of fields) {
    map[field.key] = field;
  }
  return map;
}

async function shopifyGraphql(shop, accessToken, query, variables) {
  let res = await fetch(`https://${shop}/admin/api/2026-01/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401) {
    const session = await prisma.session.findFirst({
      where: { shop, isOnline: false },
    });
    if (!session?.refreshToken) {
      throw new Error("Unauthorized and no refresh token available");
    }
    const newToken = await refreshOfflineToken(session);
    res = await fetch(`https://${shop}/admin/api/2026-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": newToken,
      },
      body: JSON.stringify({ query, variables }),
    });
    accessToken = newToken;
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      data?.errors?.[0]?.message || `Shopify API error (${res.status})`,
    );
  }

  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    throw new Error(data.errors[0]?.message || "Shopify GraphQL error");
  }

  return { data, accessToken };
}

async function refreshOfflineToken(session) {
  const response = await fetch(
    `https://${session.shop}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
      }),
    },
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }

  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  const refreshExpiresAt = data.refresh_token_expires_in
    ? new Date(Date.now() + data.refresh_token_expires_in * 1000)
    : null;

  await prisma.session.update({
    where: { id: session.id },
    data: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || session.refreshToken,
      expires: expiresAt,
      refreshTokenExpires: refreshExpiresAt || session.refreshTokenExpires,
    },
  });

  return data.access_token;
}

const MAX_SAVER_QUERY = `#graphql
  query MaxSaverData {
    shop {
      metafield(namespace: "custom", key: "max_saver") {
        type
        value
        references(first: 50) {
          nodes {
            ... on Metaobject {
              id
              fields {
                key
                type
                value
                jsonValue
                references(first: 50) {
                  nodes {
                    ... on Metaobject {
                      id
                      fields {
                        key
                        type
                        value
                        jsonValue
                        references(first: 100) {
                          nodes {
                            ... on Product {
                              id
                              legacyResourceId
                            }
                            ... on Collection {
                              id
                              legacyResourceId
                              handle
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

async function fetchMetaobjectsByIds(shop, accessToken, ids) {
  if (!ids.length) return { nodes: [], accessToken };

  const { data, accessToken: token } = await shopifyGraphql(
    shop,
    accessToken,
    `#graphql
      query MetaobjectsByIds($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Metaobject {
            id
            fields {
              key
              type
              value
              jsonValue
              references(first: 50) {
                nodes {
                  ... on Metaobject {
                    id
                    fields {
                      key
                      type
                      value
                      jsonValue
                      references(first: 100) {
                        nodes {
                          ... on Product {
                            id
                            legacyResourceId
                          }
                          ... on Collection {
                            id
                            legacyResourceId
                            handle
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `,
    { ids },
  );

  return {
    nodes: (data?.data?.nodes || []).filter(Boolean),
    accessToken: token,
  };
}

function parseGidList(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
    if (typeof parsed === "string") return [parsed];
  } catch {
    if (typeof value === "string" && value.startsWith("gid://")) {
      return [value];
    }
  }
  return [];
}

async function getCollectionProductIds(shop, accessToken, collectionId) {
  const ids = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const { data, accessToken: token } = await shopifyGraphql(
      shop,
      accessToken,
      `#graphql
        query CollectionProducts($id: ID!, $cursor: String) {
          collection(id: $id) {
            products(first: 250, after: $cursor) {
              nodes {
                legacyResourceId
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `,
      { id: collectionId, cursor },
    );
    accessToken = token;

    const connection = data?.data?.collection?.products;
    if (!connection) break;

    for (const product of connection.nodes || []) {
      const id = toNumericId(product.legacyResourceId);
      if (id != null) ids.push(id);
    }

    hasNextPage = Boolean(connection.pageInfo?.hasNextPage);
    cursor = connection.pageInfo?.endCursor || null;
  }

  return { ids: [...new Set(ids)], accessToken };
}

function buildOverride(overrideMetaobject) {
  const fields = fieldMap(overrideMetaobject?.fields || []);

  const productRefs = fields.products?.references?.nodes || [];
  const collectionRefs = fields.collections?.references?.nodes || [];

  const products = productRefs
    .map((node) => toNumericId(node.legacyResourceId || node.id))
    .filter((id) => id != null);

  const collections = collectionRefs
    .filter((node) => node.handle || node.id)
    .map((node) => ({
      id: toNumericId(node.legacyResourceId || node.id),
      handle: node.handle || null,
      gid: node.id,
      products: [],
    }));

  return {
    discount_percent: parseFieldValue(fields.discount_percent),
    priority: parseFieldValue(fields.priority),
    products,
    collections,
  };
}

function buildMaxSaver(metaobject) {
  const fields = fieldMap(metaobject?.fields || []);
  const overrideNodes = fields.override_product_list?.references?.nodes || [];

  return {
    threshold_value: parseFieldValue(fields.threshold_value),
    discount_type: parseFieldValue(fields.discount_type),
    discount_value: parseFieldValue(fields.discount_value),
    overrides: overrideNodes.map(buildOverride),
  };
}

async function expandCollections(shop, accessToken, maxSaverData) {
  const collectionCache = new Map();

  for (const maxSaver of maxSaverData) {
    for (const override of maxSaver.overrides) {
      override.products ||= [];

      for (const collection of override.collections || []) {
        if (!collection.gid && !collection.id) continue;

        const gid =
          collection.gid || `gid://shopify/Collection/${collection.id}`;

        let ids = collectionCache.get(gid);
        if (!ids) {
          const result = await getCollectionProductIds(shop, accessToken, gid);
          ids = result.ids;
          accessToken = result.accessToken;
          collectionCache.set(gid, ids);
        }

        override.products.push(...ids);
      }

      override.products = [...new Set(override.products)];
      delete override.collections;
    }
  }

  return { maxSaverData, accessToken };
}

async function handleMaxSaver(request) {
  const corsOrigin = getCorsOrigin(request);
  const url = new URL(request.url);
  const shop =
    url.searchParams.get("shop") ||
    request.headers.get("x-shopify-shop-domain");
  const expand =
    url.searchParams.get("expand_collections") !== "false";

  if (!shop) {
    return json({ ok: false, error: "Missing shop" }, 400, corsOrigin);
  }

  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false },
  });

  if (!session?.accessToken) {
    return json(
      { ok: false, error: "Offline token not found" },
      401,
      corsOrigin,
    );
  }

  let accessToken = session.accessToken;
  if (
    session.expires &&
    new Date(session.expires).getTime() < Date.now() + 5 * 60 * 1000
  ) {
    accessToken = await refreshOfflineToken(session);
  }

  const { data, accessToken: token } = await shopifyGraphql(
    shop,
    accessToken,
    MAX_SAVER_QUERY,
  );
  accessToken = token;

  const metafield = data?.data?.shop?.metafield;
  if (!metafield) {
    return json(
      { ok: true, maxSaverData: [], message: "max_saver metafield not found" },
      200,
      corsOrigin,
    );
  }

  let nodes = metafield.references?.nodes || [];
  if (!nodes.length) {
    const gids = parseGidList(metafield.value);
    const fetched = await fetchMetaobjectsByIds(shop, accessToken, gids);
    nodes = fetched.nodes;
    accessToken = fetched.accessToken;
  }

  let maxSaverData = nodes.map(buildMaxSaver);

  if (expand) {
    const result = await expandCollections(shop, accessToken, maxSaverData);
    maxSaverData = result.maxSaverData;
  }

  return json(
    {
      ok: true,
      maxSaverData,
      collectionsExpanded: expand,
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

  if (request.method !== "GET") {
    return json({ ok: false, error: "Method not allowed" }, 405, corsOrigin);
  }

  try {
    return await handleMaxSaver(request);
  } catch (error) {
    return json(
      { ok: false, error: error.message || "Failed to load max saver data" },
      500,
      corsOrigin,
    );
  }
}

export async function action({ request }) {
  const corsOrigin = getCorsOrigin(request);

  if (request.method === "OPTIONS") {
    return json({ ok: true }, 204, corsOrigin);
  }

  return json({ ok: false, error: "Use GET" }, 405, corsOrigin);
}
