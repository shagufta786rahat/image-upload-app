import { Fragment, useState } from "react";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

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

async function graphqlJson(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();
  if (json.errors?.length) {
    throw new Response(json.errors[0]?.message || "GraphQL error", {
      status: 500,
    });
  }
  return json.data;
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const wishlistEntries = await db.wishlist.findMany();
  if (wishlistEntries.length === 0) return { customers: [] };

  const allHandles = [];
  const allCustomerIds = [];

  wishlistEntries.forEach((item) => {
    allCustomerIds.push(item.customerId);

    const splitHandles = String(item.productHandle || "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    allHandles.push(...splitHandles);
  });

  const handles = [...new Set(allHandles)];
  const customerIds = [...new Set(allCustomerIds.filter(Boolean))];

  let products = [];
  if (handles.length > 0) {
    const productSearch = handles.map((h) => `handle:${h}`).join(" OR ");
    const productData = await graphqlJson(admin, PRODUCTS_QUERY, {
      query: productSearch,
    });
    products = productData?.products?.edges?.map((e) => e.node) || [];
  }

  const customerMap = {};
  if (customerIds.length > 0) {
    const customerData = await graphqlJson(admin, CUSTOMERS_QUERY, {
      ids: customerIds.map(toCustomerGid),
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

    if (!customersMap[item.customerId]) {
      customersMap[item.customerId] = {
        customerId: item.customerId,
        name: `${c.firstName || ""} ${c.lastName || ""}`.trim() || "—",
        email: c.email || "—",
        phone: c.phone || "—",
        createdAt: item.createdAt,
        items: [],
      };
    }

    const itemHandles = String(item.productHandle || "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean);
    const matchedProducts = products.filter((p) =>
      itemHandles.includes(p.handle),
    );

    customersMap[item.customerId].items.push(...matchedProducts);
  });

  return {
    customers: Object.values(customersMap),
  };
};

export default function WishlistPage() {
  const { customers } = useLoaderData();
  const [openCustomer, setOpenCustomer] = useState(null);

  return (
    <s-page heading="All Customers Wishlist Dashboard">
      {customers.length === 0 && (
        <s-section>
          <s-text>No wishlist records found.</s-text>
        </s-section>
      )}

      <s-section>
        <s-heading>Wishlist Data</s-heading>

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
                    {new Date(customer.createdAt).toLocaleString()}
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
