import { useLoaderData, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useRouteError } from "react-router";
import { authenticate } from "../shopify.server";

const PAGE_SIZE = 10;
const METAFIELD_NAMESPACE = "custom";

const CUSTOMERS_QUERY = `#graphql
  query CustomersList($first: Int, $last: Int, $after: String, $before: String) {
    customers(first: $first, last: $last, after: $after, before: $before, sortKey: UPDATED_AT, reverse: true) {
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
      edges {
        cursor
        node {
          id
          firstName
          lastName
          displayName
          updatedAt
          defaultEmailAddress {
            emailAddress
          }
          defaultPhoneNumber {
            phoneNumber
          }
          dateOfBirth: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "date_of_birth") {
            value
          }
          gender: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "gender") {
            value
          }
          socialMediaHandle: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "social_media_handle") {
            value
          }
        }
      }
    }
  }
`;

function formatCustomer(node) {
  return {
    id: node.id,
    firstName: node.firstName || "",
    lastName: node.lastName || "",
    displayName: node.displayName || "—",
    updatedAt: node.updatedAt || null,
    email: node.defaultEmailAddress?.emailAddress || "",
    phone: node.defaultPhoneNumber?.phoneNumber || "",
    customDetails: {
      dateOfBirth: node.dateOfBirth?.value || "",
      gender: node.gender?.value || "",
      socialMediaHandle: node.socialMediaHandle?.value || "",
    },
  };
}

function formatDate(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function fullName(customer) {
  const name = `${customer.firstName || ""} ${customer.lastName || ""}`.trim();
  return name || customer.displayName || "—";
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");
  const selectedId = url.searchParams.get("customerId");

  const variables = before
    ? { last: PAGE_SIZE, before }
    : { first: PAGE_SIZE, after: after || null };

  const response = await admin.graphql(CUSTOMERS_QUERY, { variables });
  const responseJson = await response.json();

  if (responseJson.errors?.length) {
    throw new Response(responseJson.errors[0]?.message || "GraphQL error", {
      status: 500,
    });
  }

  const connection = responseJson.data?.customers;
  const customers = (connection?.edges || []).map((edge) =>
    formatCustomer(edge.node),
  );
  const selected =
    customers.find((c) => c.id === selectedId) || customers[0] || null;

  return {
    customers,
    selected,
    pageInfo: connection?.pageInfo || {
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    },
  };
};

export default function CustomersPage() {
  const { customers, selected, pageInfo } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();

  const updateParams = (updates) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value == null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next);
  };

  return (
    <s-page heading="Customers">
      <s-section heading="All customers">
        <s-paragraph>
          First name, last name, email, and phone update on the customer.
          Date of birth, gender, and social handle are stored in metafields
          only (no app DB).
        </s-paragraph>

        {customers.length === 0 ? (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-paragraph>No customers found.</s-paragraph>
          </s-box>
        ) : (
          <s-stack direction="block" gap="base">
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Name</s-table-header>
                <s-table-header>Email</s-table-header>
                <s-table-header>Phone</s-table-header>
                <s-table-header>Updated</s-table-header>
                <s-table-header>Action</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {customers.map((customer) => {
                  const isSelected = selected?.id === customer.id;
                  return (
                    <s-table-row key={customer.id}>
                      <s-table-cell>{fullName(customer)}</s-table-cell>
                      <s-table-cell>{customer.email || "—"}</s-table-cell>
                      <s-table-cell>{customer.phone || "—"}</s-table-cell>
                      <s-table-cell>
                        {formatDate(customer.updatedAt)}
                      </s-table-cell>
                      <s-table-cell>
                        <s-button
                          variant={isSelected ? "primary" : "secondary"}
                          onClick={() =>
                            updateParams({ customerId: customer.id })
                          }
                        >
                          {isSelected ? "Selected" : "View"}
                        </s-button>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>

            <s-stack direction="inline" gap="base">
              <s-button
                {...(!pageInfo.hasPreviousPage ? { disabled: true } : {})}
                onClick={() =>
                  updateParams({
                    before: pageInfo.startCursor,
                    after: null,
                    customerId: null,
                  })
                }
              >
                Previous
              </s-button>
              <s-button
                {...(!pageInfo.hasNextPage ? { disabled: true } : {})}
                onClick={() =>
                  updateParams({
                    after: pageInfo.endCursor,
                    before: null,
                    customerId: null,
                  })
                }
              >
                Next
              </s-button>
            </s-stack>
          </s-stack>
        )}
      </s-section>

      {selected ? (
        <s-section heading="Customer details">
          <s-stack direction="block" gap="base">
            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-heading>Profile</s-heading>
                <s-paragraph>
                  First name: {selected.firstName || "—"}
                </s-paragraph>
                <s-paragraph>
                  Last name: {selected.lastName || "—"}
                </s-paragraph>
                <s-paragraph>Email: {selected.email || "—"}</s-paragraph>
                <s-paragraph>Phone: {selected.phone || "—"}</s-paragraph>
                <s-paragraph>
                  Last updated: {formatDate(selected.updatedAt)}
                </s-paragraph>
                <s-paragraph>Customer ID: {selected.id}</s-paragraph>
              </s-stack>
            </s-box>

            <s-box padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-heading>Custom details (metafields)</s-heading>
                <s-paragraph>
                  Date of birth: {selected.customDetails.dateOfBirth || "—"}
                </s-paragraph>
                <s-paragraph>
                  Gender: {selected.customDetails.gender || "—"}
                </s-paragraph>
                <s-paragraph>
                  Social media handle:{" "}
                  {selected.customDetails.socialMediaHandle || "—"}
                </s-paragraph>
              </s-stack>
            </s-box>
          </s-stack>
        </s-section>
      ) : null}
    </s-page>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
