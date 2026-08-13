import { useMemo, useState } from "react";
import { useLoaderData, useSearchParams, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const PAGE_SIZE = 25;

const PRODUCTS_QUERY = `#graphql
  query WishlistProducts($query: String!) {
    products(query: $query, first: 250) {
      edges {
        node {
          id
          title
          handle
          featuredImage {
            url
          }
        }
      }
    }
  }
`;

const CUSTOMERS_QUERY = `#graphql
  query WishlistCustomers($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Customer {
        id
        firstName
        lastName
        defaultEmailAddress {
          emailAddress
        }
        defaultPhoneNumber {
          phoneNumber
        }
      }
    }
  }
`;

function toCustomerGid(id) {
  const raw = String(id || "").trim();
  if (!raw) return "";
  return raw.startsWith("gid://") ? raw : `gid://shopify/Customer/${raw}`;
}

function toCustomerNumericId(id) {
  return String(id || "").replace("gid://shopify/Customer/", "");
}

function parseHandles(productHandle) {
  const raw = String(productHandle || "").trim();
  if (!raw) return [];

  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(String).map((h) => h.trim()).filter(Boolean);
      }
    } catch {
      // fall through to comma-separated parsing
    }
  }

  return raw.split(",").map((h) => h.trim()).filter(Boolean);
}

function chunk(items, size) {
  const groups = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

async function graphqlJson(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();
  if (json.errors?.length) {
    console.error("Wishlist GraphQL errors:", json.errors);
  }
  return json.data || null;
}

function wishlistModel() {
  return db.wishlist || db.Wishlist || null;
}

function mapRawWishlistDoc(doc) {
  return {
    id: String(doc._id || doc.id || ""),
    customerId: doc.customerId,
    productHandle: doc.productHandle,
    createdAt: doc.createdAt,
  };
}

async function countWishlists() {
  const model = wishlistModel();
  if (model?.count) return model.count();

  for (const collection of ["Wishlist", "wishlist"]) {
    try {
      const result = await db.$runCommandRaw({
        count: collection,
        query: {},
      });
      if (typeof result?.n === "number") return result.n;
    } catch (error) {
      console.error(`Wishlist count failed for ${collection}:`, error);
    }
  }

  throw new Error("WISHLIST_UNAVAILABLE");
}

async function findWishlists({ skip, take }) {
  const model = wishlistModel();
  if (model?.findMany) {
    return model.findMany({
      skip,
      take,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }

  for (const collection of ["Wishlist", "wishlist"]) {
    try {
      const result = await db.$runCommandRaw({
        find: collection,
        sort: { createdAt: -1, _id: -1 },
        skip,
        limit: take,
      });
      const docs = result?.cursor?.firstBatch;
      if (Array.isArray(docs)) return docs.map(mapRawWishlistDoc);
    } catch (error) {
      console.error(`Wishlist find failed for ${collection}:`, error);
    }
  }

  throw new Error("WISHLIST_UNAVAILABLE");
}

function emptyPayload(page = 1, total = 0, error = null) {
  return {
    customers: [],
    page,
    total,
    error,
    pageInfo: {
      hasNextPage: false,
      hasPreviousPage: false,
    },
  };
}

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return "—";
  }
}

function initials(name) {
  const parts = String(name || "")
    .split(" ")
    .filter(Boolean);
  if (parts.length === 0) return "W";
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function matchesQuery(customer, rawQuery) {
  const q = String(rawQuery || "").trim().toLowerCase();
  if (!q) return true;
  return [
    customer.name,
    customer.email,
    customer.phone,
    customer.customerId,
    ...(customer.items || []).map((item) => item.title),
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(q));
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const requestedPage = Math.max(
    1,
    parseInt(url.searchParams.get("page") || "1", 10) || 1,
  );

  try {
    const total = await countWishlists();
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE) || 1);
    const page = Math.min(requestedPage, totalPages);

    if (total === 0) return emptyPayload(page, total);

    const wishlistEntries = await findWishlists({
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    });

    if (wishlistEntries.length === 0) return emptyPayload(page, total);

    const allHandles = [];
    const allCustomerIds = [];

    wishlistEntries.forEach((item) => {
      allCustomerIds.push(item.customerId);
      allHandles.push(...parseHandles(item.productHandle));
    });

    const handles = [...new Set(allHandles)];
    const customerIds = [...new Set(allCustomerIds.filter(Boolean))];

    const products = [];
    for (const group of chunk(handles, 40)) {
      const productSearch = group.map((h) => `handle:${h}`).join(" OR ");
      const productData = await graphqlJson(admin, PRODUCTS_QUERY, {
        query: productSearch,
      });
      products.push(
        ...(productData?.products?.edges?.map((e) => e.node) || []),
      );
    }

    const customerMap = {};
    if (customerIds.length > 0) {
      const customerData = await graphqlJson(admin, CUSTOMERS_QUERY, {
        ids: customerIds.map(toCustomerGid).filter(Boolean),
      });

      (customerData?.nodes || []).forEach((node) => {
        if (!node?.id) return;
        const customer = {
          id: node.id,
          firstName: node.firstName,
          lastName: node.lastName,
          email: node.defaultEmailAddress?.emailAddress || "",
          phone: node.defaultPhoneNumber?.phoneNumber || "",
        };
        customerMap[toCustomerNumericId(node.id)] = customer;
        customerMap[node.id] = customer;
      });
    }

    const customersMap = {};

    wishlistEntries.forEach((item) => {
      const c = customerMap[item.customerId] || {};
      const itemHandles = parseHandles(item.productHandle);
      const matchedProducts = products.filter((p) =>
        itemHandles.includes(p.handle),
      );
      const fallbackProducts = itemHandles
        .filter((handle) => !matchedProducts.some((p) => p.handle === handle))
        .map((handle) => ({
          id: `handle:${handle}`,
          title: handle,
          handle,
          featuredImage: null,
        }));

      if (!customersMap[item.customerId]) {
        customersMap[item.customerId] = {
          customerId: item.customerId,
          name: `${c.firstName || ""} ${c.lastName || ""}`.trim() || "Customer",
          email: c.email || "",
          phone: c.phone || "",
          createdAt: item.createdAt
            ? new Date(item.createdAt).toISOString()
            : null,
          items: [],
        };
      }

      customersMap[item.customerId].items.push(
        ...matchedProducts,
        ...fallbackProducts,
      );
    });

    return {
      customers: Object.values(customersMap),
      page,
      total,
      error: null,
      pageInfo: {
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  } catch (error) {
    console.error("Wishlist loader error:", error);
    return emptyPayload(
      1,
      0,
      "We couldn’t load wishlists right now. Please refresh and try again.",
    );
  }
};

export default function Index() {
  const { customers, page, total, pageInfo, error } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const [openId, setOpenId] = useState(null);
  const [query, setQuery] = useState("");

  const filtered = useMemo(
    () => customers.filter((customer) => matchesQuery(customer, query)),
    [customers, query],
  );

  const goToPage = (nextPage) => {
    const next = new URLSearchParams(searchParams);
    if (nextPage <= 1) next.delete("page");
    else next.set("page", String(nextPage));
    setSearchParams(next);
    setOpenId(null);
  };

  const productCount = customers.reduce(
    (sum, customer) => sum + (customer.items?.length || 0),
    0,
  );

  return (
    <s-page heading="Wishlist">
      <s-section heading="Saved by customers">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            See which products customers saved. Click a row to preview the
            wishlist.
          </s-paragraph>

          {error ? (
            <s-banner heading="Couldn’t load wishlists" tone="warning">
              <s-stack direction="block" gap="small">
                <s-paragraph>{error}</s-paragraph>
                <s-button
                  variant="secondary"
                  onClick={() => window.location.reload()}
                >
                  Refresh
                </s-button>
              </s-stack>
            </s-banner>
          ) : null}

          {total > 0 ? (
            <s-grid
              gridTemplateColumns="1fr auto"
              gap="base"
              alignItems="end"
            >
              <s-search-field
                label="Search wishlists"
                labelAccessibilityVisibility="exclusive"
                value={query}
                placeholder="Search by name, email, phone, or product"
                autocomplete="off"
                onInput={(event) => setQuery(event.currentTarget.value)}
              />
              <s-button
                variant="tertiary"
                {...(!query ? { disabled: true } : {})}
                onClick={() => setQuery("")}
              >
                Clear
              </s-button>
            </s-grid>
          ) : null}

          {total > 0 ? (
            <s-text color="subdued">
              {total} customer{total === 1 ? "" : "s"} · {productCount} saved
              product{productCount === 1 ? "" : "s"}
              {total > PAGE_SIZE ? ` · Page ${page}` : ""}
            </s-text>
          ) : null}

          {customers.length === 0 && !error ? (
            <s-box padding="base" border="base" borderRadius="base">
              <s-grid gap="base" justifyItems="center" paddingBlock="large-400">
                <s-box maxInlineSize="200px">
                  <s-image
                    aspectRatio="1/0.5"
                    src="https://cdn.shopify.com/static/images/polaris/patterns/callout.png"
                    alt="Empty wishlist illustration"
                  />
                </s-box>
                <s-stack alignItems="center">
                  <s-heading>No wishlists yet</s-heading>
                  <s-paragraph>
                    When customers save products on the storefront, they will
                    show up here.
                  </s-paragraph>
                </s-stack>
              </s-grid>
            </s-box>
          ) : null}

          {customers.length > 0 && filtered.length === 0 ? (
            <s-box padding="base" border="base" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-paragraph>
                  No customers matched “{query}”.
                </s-paragraph>
                <s-button variant="secondary" onClick={() => setQuery("")}>
                  Clear search
                </s-button>
              </s-stack>
            </s-box>
          ) : null}

          {filtered.length > 0 ? (
            <s-box border="base" borderRadius="base" overflow="hidden">
              {filtered.map((customer, index) => {
                const isOpen = openId === customer.customerId;
                const subtitle = [customer.email, customer.phone]
                  .filter(Boolean)
                  .join(" · ");
                const count = customer.items.length;

                return (
                  <s-stack
                    key={customer.customerId}
                    direction="block"
                    gap="none"
                  >
                    {index > 0 ? (
                      <s-box paddingInline="base">
                        <s-divider />
                      </s-box>
                    ) : null}

                    <s-clickable
                      padding="base"
                      accessibilityLabel={`${isOpen ? "Collapse" : "Expand"} wishlist for ${customer.name}`}
                      onClick={() =>
                        setOpenId(isOpen ? null : customer.customerId)
                      }
                    >
                      <s-grid
                        gridTemplateColumns="auto 1fr auto"
                        gap="base"
                        alignItems="center"
                      >
                        <s-avatar initials={initials(customer.name)} />
                        <s-stack direction="block" gap="none">
                          <s-heading>{customer.name}</s-heading>
                          <s-paragraph color="subdued">
                            {subtitle || "No email / phone"}
                          </s-paragraph>
                        </s-stack>
                        <s-stack
                          direction="inline"
                          gap="small"
                          alignItems="center"
                        >
                          <s-badge>
                            {count} product{count === 1 ? "" : "s"}
                          </s-badge>
                          <s-text color="subdued">
                            {formatDate(customer.createdAt)}
                          </s-text>
                          <s-icon
                            type={isOpen ? "chevron-up" : "chevron-down"}
                          />
                        </s-stack>
                      </s-grid>
                    </s-clickable>

                    {isOpen ? (
                      <s-box
                        padding="base"
                        background="subdued"
                        borderStyle="solid none none none"
                        border="base"
                      >
                        <s-stack direction="block" gap="base">
                          <s-heading>Wishlist products</s-heading>
                          {customer.items.length === 0 ? (
                            <s-paragraph>
                              This customer has no saved products.
                            </s-paragraph>
                          ) : (
                            <s-grid
                              gridTemplateColumns="repeat(auto-fill, minmax(160px, 1fr))"
                              gap="base"
                            >
                              {customer.items.map((prod) => (
                                <s-box
                                  key={prod.id}
                                  padding="small"
                                  background="base"
                                  border="base"
                                  borderRadius="base"
                                >
                                  <s-stack direction="block" gap="small">
                                    {prod.featuredImage?.url ? (
                                      <s-thumbnail
                                        size="large"
                                        src={prod.featuredImage.url}
                                        alt={prod.title}
                                      />
                                    ) : (
                                      <s-box
                                        padding="base"
                                        background="subdued"
                                        borderRadius="base"
                                      >
                                        <s-text color="subdued">
                                          No image
                                        </s-text>
                                      </s-box>
                                    )}
                                    <s-text>{prod.title}</s-text>
                                  </s-stack>
                                </s-box>
                              ))}
                            </s-grid>
                          )}
                          <s-text color="subdued">
                            Customer ID: {customer.customerId}
                          </s-text>
                        </s-stack>
                      </s-box>
                    ) : null}
                  </s-stack>
                );
              })}
            </s-box>
          ) : null}

          {pageInfo.hasPreviousPage || pageInfo.hasNextPage ? (
            <s-stack direction="inline" gap="base">
              <s-button
                {...(!pageInfo.hasPreviousPage ? { disabled: true } : {})}
                onClick={() => goToPage(page - 1)}
              >
                Previous
              </s-button>
              <s-button
                {...(!pageInfo.hasNextPage ? { disabled: true } : {})}
                onClick={() => goToPage(page + 1)}
              >
                Next
              </s-button>
            </s-stack>
          ) : null}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
