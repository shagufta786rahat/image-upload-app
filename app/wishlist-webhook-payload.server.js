import db from "./db.server";
import { getOfflineSession, shopifyGraphql } from "./shopify-api.server";

const PRODUCTS_QUERY = `#graphql
  query WishlistWebhookProducts($query: String!) {
    products(query: $query, first: 250) {
      edges {
        node {
          id
          title
          handle
          vendor
          productType
          status
          tags
          onlineStoreUrl
          featuredImage {
            url
            altText
          }
          priceRangeV2 {
            minVariantPrice {
              amount
              currencyCode
            }
          }
        }
      }
    }
  }
`;

const CUSTOMER_QUERY = `#graphql
  query WishlistWebhookCustomer($id: ID!) {
    customer(id: $id) {
      id
      firstName
      lastName
      displayName
      defaultEmailAddress {
        emailAddress
      }
      defaultPhoneNumber {
        phoneNumber
      }
    }
  }
`;

const SHOP_QUERY = `#graphql
  query WishlistWebhookShop {
    shop {
      name
      myshopifyDomain
      primaryDomain {
        host
        url
      }
    }
  }
`;

function cleanShop(shop) {
  return String(shop || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

function toCustomerGid(id) {
  const raw = String(id || "").trim();
  if (!raw) return "";
  return raw.startsWith("gid://") ? raw : `gid://shopify/Customer/${raw}`;
}

function toCustomerNumericId(id) {
  return String(id || "").replace(/^gid:\/\/shopify\/Customer\//, "");
}

function fallbackProduct(handle) {
  return {
    id: null,
    gid: null,
    title: handle,
    handle,
    vendor: "",
    productType: "",
    status: "",
    tags: [],
    url: null,
    image: null,
    price: null,
    currency: null,
  };
}

function mapProduct(node) {
  if (!node) return null;
  const price = node.priceRangeV2?.minVariantPrice;
  return {
    id: String(node.id || "").replace("gid://shopify/Product/", ""),
    gid: node.id,
    title: node.title || node.handle,
    handle: node.handle,
    vendor: node.vendor || "",
    productType: node.productType || "",
    status: node.status || "",
    tags: node.tags || [],
    url: node.onlineStoreUrl || null,
    image: node.featuredImage?.url
      ? { url: node.featuredImage.url, alt: node.featuredImage.altText || node.title }
      : null,
    price: price?.amount || null,
    currency: price?.currencyCode || null,
  };
}

function fallbackCustomer(customerId) {
  return {
    id: toCustomerNumericId(customerId),
    gid: toCustomerGid(customerId),
    firstName: "",
    lastName: "",
    name: "",
    email: "",
    phone: "",
  };
}

function mapCustomer(node, customerId) {
  if (!node) return fallbackCustomer(customerId);
  const firstName = node.firstName || "";
  const lastName = node.lastName || "";
  return {
    id: toCustomerNumericId(node.id),
    gid: node.id,
    firstName,
    lastName,
    name: (node.displayName || `${firstName} ${lastName}`).trim(),
    email: node.defaultEmailAddress?.emailAddress || "",
    phone: node.defaultPhoneNumber?.phoneNumber || "",
  };
}

export async function resolveShop(request, body = {}) {
  const url = new URL(request.url);
  const fromRequest = cleanShop(
    body.shop ||
      url.searchParams.get("shop") ||
      request.headers.get("x-shopify-shop-domain") ||
      process.env.SHOP ||
      process.env.SHOPIFY_SHOP,
  );
  if (fromRequest) return fromRequest;

  try {
    const session = await db.session.findFirst({ where: { isOnline: false } });
    return cleanShop(session?.shop);
  } catch (error) {
    console.error("Wishlist webhook shop lookup failed:", error);
    return "";
  }
}

async function fetchProductsByHandles(shop, accessToken, handles) {
  const unique = [...new Set((handles || []).filter(Boolean))];
  if (!unique.length) return [];

  const query = unique.map((handle) => `handle:${handle}`).join(" OR ");
  const { data } = await shopifyGraphql(shop, accessToken, PRODUCTS_QUERY, {
    query,
  });
  const nodes = data?.data?.products?.edges?.map((edge) => edge.node) || [];
  const mapped = nodes.map(mapProduct).filter(Boolean);
  const byHandle = new Map(mapped.map((product) => [product.handle, product]));
  return unique.map((handle) => byHandle.get(handle) || fallbackProduct(handle));
}

export async function buildWishlistWebhookData({
  shop,
  customerId,
  handles = [],
  added = [],
  removed = [],
}) {
  const base = {
    shop: shop
      ? { domain: shop, myshopifyDomain: shop }
      : null,
    customer: fallbackCustomer(customerId),
    customerId: toCustomerNumericId(customerId),
    handles,
    products: handles.map(fallbackProduct),
    ...(added.length ? { added: added.map(fallbackProduct), addedHandles: added } : {}),
    ...(removed.length
      ? { removed: removed.map(fallbackProduct), removedHandles: removed }
      : {}),
  };

  if (!shop) return base;

  const offline = await getOfflineSession(shop);
  if (!offline?.accessToken) {
    console.error(`Wishlist webhook: no offline token for ${shop}`);
    return base;
  }

  try {
    const fetchHandles = [...new Set([...handles, ...added, ...removed])];
    const [products, customerResult, shopResult] = await Promise.all([
      fetchProductsByHandles(shop, offline.accessToken, fetchHandles),
      shopifyGraphql(shop, offline.accessToken, CUSTOMER_QUERY, {
        id: toCustomerGid(customerId),
      }).catch((error) => {
        console.error("Wishlist webhook customer fetch failed:", error);
        return { data: {} };
      }),
      shopifyGraphql(shop, offline.accessToken, SHOP_QUERY).catch((error) => {
        console.error("Wishlist webhook shop fetch failed:", error);
        return { data: {} };
      }),
    ]);

    const productByHandle = new Map(
      products.map((product) => [product.handle, product]),
    );
    const pick = (list) =>
      list.map((handle) => productByHandle.get(handle) || fallbackProduct(handle));

    const shopNode = shopResult?.data?.data?.shop || shopResult?.data?.shop;
    const customerNode =
      customerResult?.data?.data?.customer || customerResult?.data?.customer;

    return {
      shop: shopNode
        ? {
            name: shopNode.name,
            domain: shopNode.primaryDomain?.host || shop,
            url: shopNode.primaryDomain?.url || null,
            myshopifyDomain: shopNode.myshopifyDomain || shop,
          }
        : base.shop,
      customer: mapCustomer(customerNode, customerId),
      customerId: toCustomerNumericId(customerId),
      handles,
      products: pick(handles),
      ...(added.length
        ? { added: pick(added), addedHandles: added }
        : {}),
      ...(removed.length
        ? { removed: pick(removed), removedHandles: removed }
        : {}),
    };
  } catch (error) {
    console.error("Wishlist webhook enrich failed:", error);
    return base;
  }
}
