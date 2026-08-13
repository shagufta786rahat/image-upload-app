import { useLoaderData } from "react-router";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import db from "../db.server";


// ------------------------------------------------------
// 1. LOADER — Fetch wishlist, products & customer details
// ------------------------------------------------------
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // Fetch all wishlist entries
  const wishlistEntries = await db.wishlist.findMany();
  if (wishlistEntries.length === 0) return { customers: [] };

  let allHandles = [];
  let allCustomerIds = [];

  wishlistEntries.forEach((item) => {
    allCustomerIds.push(item.customerId);

    const splitHandles = item.productHandle.split(",").map((h) => h.trim());
    allHandles.push(...splitHandles);
  });

  const handles = [...new Set(allHandles)];
  const customerIds = [...new Set(allCustomerIds)];

  // ------------------------------------------------------
  // Fetch Products from Shopify
  // ------------------------------------------------------
  const productSearch = handles.map((h) => `handle:${h}`).join(" OR ");

  const productQuery = `
    query {
      products(query: "${productSearch}", first: 250) {
        edges {
          node {
            id
            title
            handle
            featuredImage { url }
          }
        }
      }
    }
  `;

  const productRes = await admin.graphql(productQuery);
  const productJson = await productRes.json();
  const products = productJson.data.products.edges.map((e) => e.node);


  // ------------------------------------------------------
  // Fetch Customer Details from Shopify
  // ------------------------------------------------------
  const customerQuery = `
    query {
      customers(first: 250, query: "${customerIds
        .map((id) => `id:${id}`)
        .join(" OR ")}") {
        edges {
          node {
            id
            email
            phone
            firstName
            lastName
          }
        }
      }
    }
  `;

  const customerRes = await admin.graphql(customerQuery);
  const customerJson = await customerRes.json();

  // Map: "12345" → { customerData }
  const customerMap = {};
  customerJson.data.customers.edges.forEach((c) => {
    customerMap[c.node.id.replace("gid://shopify/Customer/", "")] = c.node;
  });


  // ------------------------------------------------------
  // Group wishlist by customer
  // ------------------------------------------------------
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

    const itemHandles = item.productHandle.split(",").map((h) => h.trim());
    const matchedProducts = products.filter((p) =>
      itemHandles.includes(p.handle)
    );

    customersMap[item.customerId].items.push(...matchedProducts);
  });

  return {
    customers: Object.values(customersMap),
  };
};




// ------------------------------------------------------
// 2. UI COMPONENT
// ------------------------------------------------------
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
              <>
                <tr key={customer.customerId}>
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
                            : customer.customerId
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
                              style={productImg}
                            />
                            <p style={prodTitle}>{prod.title}</p>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </s-section>
    </s-page>
  );
}



// ------------------------------------------------------
// 3. STYLES
// ------------------------------------------------------
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
