import { useEffect, useState } from "react";
import { useLoaderData, useSearchParams, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const PAGE_SIZE = 25;
const FETCH_CAP = 500;

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

const CUSTOMERS_BY_IDS_QUERY = `#graphql
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

const CUSTOMERS_SEARCH_QUERY = `#graphql
  query WishlistCustomerSearch($query: String!) {
    customers(first: 50, query: $query) {
      edges {
        node {
          id
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

function customerIdVariants(id) {
  const raw = String(id || "").trim();
  if (!raw) return [];
  return [...new Set([raw, toCustomerNumericId(raw), toCustomerGid(raw)])];
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

function escapeSearchTerm(term) {
  return String(term).trim().replace(/[\\:()]/g, "\\$&");
}

function buildCustomerSearchQuery(raw) {
  const term = String(raw || "").trim();
  if (!term) return null;

  const escaped = escapeSearchTerm(term);
  if (!escaped) return null;

  if (term.includes("@")) return `email:${escaped}*`;

  const digits = term.replace(/\D/g, "");
  const compact = term.replace(/\s/g, "");
  if (digits.length >= 7 && digits.length >= compact.length * 0.6) {
    return `phone:${digits}* OR phone:+${digits}*`;
  }

  return [
    escaped,
    `first_name:${escaped}*`,
    `last_name:${escaped}*`,
    `email:${escaped}*`,
    `phone:${escaped}*`,
  ].join(" OR ");
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

async function countWishlists(where = {}) {
  const model = wishlistModel();
  if (model?.count) return model.count({ where });

  for (const collection of ["Wishlist", "wishlist"]) {
    try {
      const result = await db.$runCommandRaw({
        count: collection,
        query: toMongoFilter(where),
      });
      if (typeof result?.n === "number") return result.n;
    } catch (error) {
      console.error(`Wishlist count failed for ${collection}:`, error);
    }
  }

  throw new Error("WISHLIST_UNAVAILABLE");
}

async function findWishlists({ skip, take, where = {} } = {}) {
  const model = wishlistModel();
  if (model?.findMany) {
    return model.findMany({
      where,
      ...(skip != null ? { skip } : {}),
      ...(take != null ? { take } : {}),
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }

  for (const collection of ["Wishlist", "wishlist"]) {
    try {
      const command = {
        find: collection,
        filter: toMongoFilter(where),
        sort: { createdAt: -1, _id: -1 },
      };
      if (skip) command.skip = skip;
      if (take) command.limit = take;
      const result = await db.$runCommandRaw(command);
      const docs = result?.cursor?.firstBatch;
      if (Array.isArray(docs)) return docs.map(mapRawWishlistDoc);
    } catch (error) {
      console.error(`Wishlist find failed for ${collection}:`, error);
    }
  }

  throw new Error("WISHLIST_UNAVAILABLE");
}

function uniqueEntries(entries) {
  const seen = new Set();
  return entries.filter((item) => {
    const key = String(item.customerId || item.id);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function periodSince(period) {
  const now = new Date();
  if (period === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start;
  }
  if (period === "7d") return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (period === "30d") return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return null;
}

function matchesSize(count, size) {
  if (size === "1") return count === 1;
  if (size === "few") return count >= 2 && count <= 5;
  if (size === "many") return count >= 6;
  return true;
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
    ...(customer.items || []).map((item) => item.handle),
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(q));
}

function emptyPayload({
  page = 1,
  total = 0,
  error = null,
  q = "",
  period = "all",
  size = "all",
} = {}) {
  return {
    customers: [],
    page,
    total,
    error,
    q,
    period,
    size,
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

async function searchCustomerIds(admin, q) {
  const query = buildCustomerSearchQuery(q);
  if (!query) return [];
  const data = await graphqlJson(admin, CUSTOMERS_SEARCH_QUERY, { query });
  return (data?.customers?.edges || [])
    .map((edge) => edge.node?.id)
    .filter(Boolean)
    .flatMap(customerIdVariants);
}

async function enrichWishlists(admin, wishlistEntries) {
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
    products.push(...(productData?.products?.edges?.map((e) => e.node) || []));
  }

  const customerMap = {};
  if (customerIds.length > 0) {
    const customerData = await graphqlJson(admin, CUSTOMERS_BY_IDS_QUERY, {
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

  return Object.values(customersMap);
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const period = ["today", "7d", "30d"].includes(url.searchParams.get("period"))
    ? url.searchParams.get("period")
    : "all";
  const size = ["1", "few", "many"].includes(url.searchParams.get("size"))
    ? url.searchParams.get("size")
    : "all";
  const requestedPage = Math.max(
    1,
    parseInt(url.searchParams.get("page") || "1", 10) || 1,
  );

  const filters = { q, period, size };

  try {
    const since = periodSince(period);
    const dateWhere = since ? { createdAt: { gte: since } } : {};
    const needsMemoryFilter = Boolean(q || size !== "all");

    let wishlistEntries = [];

    if (q) {
      const [byHandle, customerIds] = await Promise.all([
        findWishlists({
          where: { ...dateWhere, productHandle: { contains: q } },
          take: FETCH_CAP,
        }),
        searchCustomerIds(admin, q),
      ]);

      const byCustomer = customerIds.length
        ? await findWishlists({
            where: { ...dateWhere, customerId: { in: customerIds } },
            take: FETCH_CAP,
          })
        : [];

      const byCustomerId = customerIdVariants(q).length
        ? await findWishlists({
            where: { ...dateWhere, customerId: { in: customerIdVariants(q) } },
            take: FETCH_CAP,
          })
        : [];

      wishlistEntries = uniqueEntries([
        ...byHandle,
        ...byCustomer,
        ...byCustomerId,
      ]);
    } else if (needsMemoryFilter) {
      wishlistEntries = await findWishlists({
        where: dateWhere,
        take: FETCH_CAP,
      });
    } else {
      const total = await countWishlists(dateWhere);
      const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE) || 1);
      const page = Math.min(requestedPage, totalPages);
      if (total === 0) return emptyPayload({ ...filters, page, total });

      wishlistEntries = await findWishlists({
        where: dateWhere,
        skip: (page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      });

      const customers = await enrichWishlists(admin, wishlistEntries);
      return {
        customers,
        page,
        total,
        error: null,
        ...filters,
        pageInfo: {
          hasNextPage: page < totalPages,
          hasPreviousPage: page > 1,
        },
      };
    }

    let customers = await enrichWishlists(admin, wishlistEntries);
    customers = customers.filter((customer) => {
      const count = customer.items?.length || 0;
      return matchesQuery(customer, q) && matchesSize(count, size);
    });

    const total = customers.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE) || 1);
    const page = Math.min(requestedPage, totalPages);
    const start = (page - 1) * PAGE_SIZE;

    return {
      customers: customers.slice(start, start + PAGE_SIZE),
      page,
      total,
      error: null,
      ...filters,
      pageInfo: {
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  } catch (error) {
    console.error("Wishlist loader error:", error);
    return emptyPayload({
      ...filters,
      error:
        "We couldn’t load wishlists right now. Please refresh and try again.",
    });
  }
};

export default function Index() {
  const { customers, page, total, pageInfo, error, q, period, size } =
    useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const [openId, setOpenId] = useState(null);
  const [draft, setDraft] = useState(q || "");

  useEffect(() => {
    setDraft(q || "");
  }, [q]);

  const updateParams = (updates) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (
        value == null ||
        value === "" ||
        value === "all" ||
        (key === "page" && Number(value) <= 1)
      ) {
        next.delete(key);
      } else next.set(key, String(value));
    }
    setSearchParams(next);
    setOpenId(null);
  };

  const runSearch = (value = draft) => {
    updateParams({
      q: String(value || "").trim() || null,
      page: null,
    });
  };

  const clearAll = () => {
    setDraft("");
    setSearchParams(new URLSearchParams());
    setOpenId(null);
  };

  const hasFilters = Boolean(q || period !== "all" || size !== "all");
  const productCount = customers.reduce(
    (sum, customer) => sum + (customer.items?.length || 0),
    0,
  );

  const periodLabel =
    period === "today"
      ? "Today"
      : period === "7d"
        ? "Last 7 days"
        : period === "30d"
          ? "Last 30 days"
          : null;
  const sizeLabel =
    size === "1"
      ? "1 product"
      : size === "few"
        ? "2–5 products"
        : size === "many"
          ? "6+ products"
          : null;

  return (
    <s-page heading="Wishlist">
      <s-section heading="Saved by customers">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Search by customer or product, then filter by date and wishlist
            size. Click a row to preview saved products.
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

          <s-grid
            gridTemplateColumns="1fr auto auto"
            gap="base"
            alignItems="end"
          >
            <s-search-field
              label="Search wishlists"
              labelAccessibilityVisibility="exclusive"
              name="q"
              value={draft}
              placeholder="Search by name, email, phone, or product"
              autocomplete="off"
              onInput={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  runSearch(event.currentTarget.value);
                }
              }}
            />
            <s-button variant="primary" onClick={() => runSearch()}>
              Search
            </s-button>
            <s-button
              variant="tertiary"
              {...(!hasFilters && !draft ? { disabled: true } : {})}
              onClick={clearAll}
            >
              Clear
            </s-button>
          </s-grid>

          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-select
              label="Date saved"
              name="period"
              value={period}
              onChange={(event) =>
                updateParams({
                  period: event.currentTarget.value,
                  page: null,
                })
              }
            >
              <s-option value="all">All time</s-option>
              <s-option value="today">Today</s-option>
              <s-option value="7d">Last 7 days</s-option>
              <s-option value="30d">Last 30 days</s-option>
            </s-select>
            <s-select
              label="Products saved"
              name="size"
              value={size}
              onChange={(event) =>
                updateParams({
                  size: event.currentTarget.value,
                  page: null,
                })
              }
            >
              <s-option value="all">Any amount</s-option>
              <s-option value="1">1 product</s-option>
              <s-option value="few">2–5 products</s-option>
              <s-option value="many">6+ products</s-option>
            </s-select>
          </s-grid>

          {hasFilters ? (
            <s-banner tone="info">
              <s-stack direction="block" gap="small">
                <s-paragraph>
                  Showing filtered results
                  {q ? ` for “${q}”` : ""}
                  {periodLabel ? ` · ${periodLabel}` : ""}
                  {sizeLabel ? ` · ${sizeLabel}` : ""}.
                </s-paragraph>
                <s-button variant="tertiary" onClick={clearAll}>
                  Clear filters
                </s-button>
              </s-stack>
            </s-banner>
          ) : null}

          {total > 0 ? (
            <s-text color="subdued">
              {total} customer{total === 1 ? "" : "s"}
              {productCount
                ? ` · ${productCount} saved product${productCount === 1 ? "" : "s"} on this page`
                : ""}
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
                  <s-heading>
                    {hasFilters ? "No matching wishlists" : "No wishlists yet"}
                  </s-heading>
                  <s-paragraph>
                    {hasFilters
                      ? "Try another search, date, or product filter."
                      : "When customers save products on the storefront, they will show up here."}
                  </s-paragraph>
                  {hasFilters ? (
                    <s-button variant="secondary" onClick={clearAll}>
                      Clear filters
                    </s-button>
                  ) : null}
                </s-stack>
              </s-grid>
            </s-box>
          ) : null}

          {customers.length > 0 ? (
            <s-box border="base" borderRadius="base" overflow="hidden">
              {customers.map((customer, index) => {
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
                onClick={() => updateParams({ page: page - 1 })}
              >
                Previous
              </s-button>
              <s-button
                {...(!pageInfo.hasNextPage ? { disabled: true } : {})}
                onClick={() => updateParams({ page: page + 1 })}
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
