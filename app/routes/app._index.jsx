import { Fragment, useState } from "react";
import { useLoaderData, useSearchParams, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

const PAGE_SIZE = 50;

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

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const requestedPage = Math.max(
    1,
    parseInt(url.searchParams.get("page") || "1", 10) || 1,
  );

  try {
    const total = await db.wishlist.count();
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE) || 1);
    const page = Math.min(requestedPage, totalPages);

    if (total === 0) return emptyPayload(page, total);

    const wishlistEntries = await db.wishlist.findMany({
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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

      if (!customersMap[item.customerId]) {
        customersMap[item.customerId] = {
          customerId: item.customerId,
          name: `${c.firstName || ""} ${c.lastName || ""}`.trim() || "—",
          email: c.email || "—",
          phone: c.phone || "—",
          createdAt: item.createdAt
            ? new Date(item.createdAt).toISOString()
            : null,
          items: [],
        };
      }

      customersMap[item.customerId].items.push(...matchedProducts);
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
    return emptyPayload(1, 0, error?.message || "Failed to load wishlist");
  }
};

export default function Index() {
  const { customers, page, total, pageInfo, error } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const [openCustomer, setOpenCustomer] = useState(null);

  const goToPage = (nextPage) => {
    const next = new URLSearchParams(searchParams);
    if (nextPage <= 1) next.delete("page");
    else next.set("page", String(nextPage));
    setSearchParams(next);
    setOpenCustomer(null);
  };

  return (
    <s-page heading="All Customers Wishlist Dashboard">
      {error ? (
        <s-section>
          <s-banner tone="critical">{error}</s-banner>
        </s-section>
      ) : null}

      {customers.length === 0 && !error && (
        <s-section>
          <s-text>No wishlist records found.</s-text>
        </s-section>
      )}

      <s-section>
        <s-heading>Wishlist Data</s-heading>
        {total > 0 ? (
          <s-text color="subdued">
            Showing {customers.length} of {total} customer
            {total === 1 ? "" : "s"}
            {total > PAGE_SIZE ? ` · Page ${page}` : ""}
          </s-text>
        ) : null}

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={th}>Customer ID</th>
              <th style={th}>Name</th>
              <th style={th}>Email</th>
              <th style={th}>Phone</th>
              <th style={th}>Date</th>
              <th style={th}>Product IDs</th>
              <th style={th}>Action</th>
            </tr>
          </thead>

          <tbody>
            {customers.map((customer) => (
              <Fragment key={customer.customerId}>
                <tr>
                  <td style={td}>{customer.customerId}</td>
                  <td style={td}>{customer.name}</td>
                  <td style={td}>{customer.email}</td>
                  <td style={td}>{customer.phone}</td>

                  <td style={td}>
                    {customer.createdAt
                      ? new Date(customer.createdAt).toLocaleString()
                      : "—"}
                  </td>

                  <td style={td}>
                    {customer.items
                      .map((p) => p.id.replace("gid://shopify/Product/", ""))
                      .join(", ")}
                  </td>

                  <td style={td}>
                    <button
                      onClick={() =>
                        setOpenCustomer(
                          openCustomer === customer.customerId
                            ? null
                            : customer.customerId,
                        )
                      }
                      style={buttonStyle}
                    >
                      View Products
                    </button>
                  </td>
                </tr>

                {openCustomer === customer.customerId && (
                  <tr>
                    <td colSpan={7} style={{ padding: "15px" }}>
                      <div style={productGrid}>
                        {customer.items.map((prod) => (
                          <div key={prod.id} style={productCard}>
                            <img
                              src={prod.featuredImage?.url}
                              alt={prod.title}
                              style={productImg}
                            />
                            <p style={prodTitle}>{prod.title}</p>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>

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

const th = {
  textAlign: "left",
  padding: "10px",
  borderBottom: "1px solid #ddd",
};

const td = {
  padding: "10px",
  borderBottom: "1px solid #eee",
};

const buttonStyle = {
  padding: "6px 12px",
  background: "#000",
  color: "#fff",
  border: "none",
  borderRadius: "6px",
  cursor: "pointer",
};

const productGrid = {
  display: "flex",
  gap: "20px",
  flexWrap: "wrap",
};

const productCard = {
  width: "180px",
  padding: "10px",
  border: "1px solid #ddd",
  borderRadius: "8px",
  textAlign: "center",
};

const productImg = {
  width: "100%",
  borderRadius: "6px",
};

const prodTitle = {
  fontWeight: "bold",
  marginTop: "10px",
};
