import { useEffect, useState } from "react";
import { useLoaderData, useSearchParams, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

const PAGE_SIZE = 50;
const METAFIELD_NAMESPACE = "eshop";

const CUSTOMERS_QUERY = `#graphql
  query CustomersList(
    $first: Int
    $last: Int
    $after: String
    $before: String
    $query: String
  ) {
    customers(
      first: $first
      last: $last
      after: $after
      before: $before
      query: $query
      sortKey: UPDATED_AT
      reverse: true
    ) {
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
            marketingState
            marketingOptInLevel
            marketingUpdatedAt
          }
          defaultPhoneNumber {
            phoneNumber
            marketingState
            marketingOptInLevel
            marketingUpdatedAt
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
          profilePicture: metafield(namespace: "${METAFIELD_NAMESPACE}", key: "profile_picture") {
            value
            reference {
              ... on MediaImage {
                id
                image {
                  url
                  altText
                }
              }
              ... on GenericFile {
                id
                url
              }
            }
          }
        }
      }
    }
  }
`;

function escapeSearchTerm(term) {
  return String(term).trim().replace(/[\\:()]/g, "\\$&");
}

/** Build Shopify customers search query for name / email / phone. */
function buildCustomerSearchQuery(raw) {
  const term = String(raw || "").trim();
  if (!term) return null;

  const escaped = escapeSearchTerm(term);
  if (!escaped) return null;

  if (term.includes("@")) {
    return `email:${escaped}*`;
  }

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

function formatMarketing(contact) {
  const marketingState = contact?.marketingState || "NOT_SUBSCRIBED";
  return {
    enabled: marketingState === "SUBSCRIBED",
    marketingState,
    marketingOptInLevel: contact?.marketingOptInLevel || "",
    consentUpdatedAt: contact?.marketingUpdatedAt || null,
  };
}

function marketingLabel(state) {
  if (state === "SUBSCRIBED") return "On";
  if (state === "PENDING") return "Pending";
  if (state === "UNSUBSCRIBED") return "Off";
  return "Off";
}

function marketingTone(state) {
  if (state === "SUBSCRIBED") return "success";
  if (state === "PENDING") return "caution";
  return undefined;
}

function formatCustomer(node) {
  const profileRef = node.profilePicture?.reference;
  const profileUrl = profileRef?.image?.url || profileRef?.url || "";
  const emailMarketing = formatMarketing(node.defaultEmailAddress);
  const smsMarketing = formatMarketing(node.defaultPhoneNumber);
  return {
    id: node.id,
    firstName: node.firstName || "",
    lastName: node.lastName || "",
    displayName: node.displayName || "—",
    updatedAt: node.updatedAt || null,
    email: node.defaultEmailAddress?.emailAddress || "",
    phone: node.defaultPhoneNumber?.phoneNumber || "",
    emailMarketing,
    smsMarketing,
    customDetails: {
      dateOfBirth: node.dateOfBirth?.value || "",
      gender: node.gender?.value || "",
      socialMediaHandle: node.socialMediaHandle?.value || "",
      profilePicture: {
        fileId: node.profilePicture?.value || profileRef?.id || "",
        url: profileUrl,
      },
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

function DetailRow({ label, value }) {
  return (
    <s-grid gridTemplateColumns="160px 1fr" gap="base" alignItems="start">
      <s-text color="subdued">{label}</s-text>
      <s-text>{value || "—"}</s-text>
    </s-grid>
  );
}

function MarketingBadge({ channel, state }) {
  const tone = marketingTone(state);
  return (
    <s-badge {...(tone ? { tone } : {})}>
      {channel} {marketingLabel(state)}
    </s-badge>
  );
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const after = url.searchParams.get("after");
  const before = url.searchParams.get("before");
  const q = (url.searchParams.get("q") || "").trim();
  const query = buildCustomerSearchQuery(q);

  const variables = before
    ? { last: PAGE_SIZE, before, query }
    : { first: PAGE_SIZE, after: after || null, query };

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

  return {
    customers,
    q,
    pageInfo: connection?.pageInfo || {
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    },
  };
};

export default function CustomersPage() {
  const { customers, pageInfo, q } = useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const [openId, setOpenId] = useState(null);
  const [draft, setDraft] = useState(q || "");

  useEffect(() => {
    setDraft(q || "");
  }, [q]);

  const updateParams = (updates) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value == null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next);
    setOpenId(null);
  };

  const runSearch = (value = draft) => {
    updateParams({
      q: String(value || "").trim() || null,
      after: null,
      before: null,
    });
  };

  const clearSearch = () => {
    setDraft("");
    updateParams({
      q: null,
      after: null,
      before: null,
    });
  };

  const toggle = (id) => {
    setOpenId((current) => (current === id ? null : id));
  };

  return (
    <s-page heading="Customers">
      <s-section heading="All customers">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Search by name, email, or phone. Click a row to expand profile,
            marketing consent, and custom metafield details.
          </s-paragraph>

          <s-grid
            gridTemplateColumns="1fr auto auto"
            gap="base"
            alignItems="end"
          >
            <s-search-field
              label="Search customers"
              labelAccessibilityVisibility="exclusive"
              name="q"
              value={draft}
              placeholder="Search by name, email, or phone"
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
              {...(!q && !draft ? { disabled: true } : {})}
              onClick={clearSearch}
            >
              Clear
            </s-button>
          </s-grid>

          {q ? (
            <s-banner tone="info">
              Showing results for “{q}”. Use Clear to reset the list.
            </s-banner>
          ) : null}

          {customers.length === 0 ? (
            <s-box padding="base" border="base" borderRadius="base">
              <s-stack direction="block" gap="small">
                <s-paragraph>
                  {q
                    ? `No customers matched “${q}”.`
                    : "No customers found."}
                </s-paragraph>
                {q ? (
                  <s-button variant="secondary" onClick={clearSearch}>
                    Clear search
                  </s-button>
                ) : null}
              </s-stack>
            </s-box>
          ) : (
            <s-stack direction="block" gap="base">
              <s-text color="subdued">
                Showing {customers.length} customer
                {customers.length === 1 ? "" : "s"}
                {q ? ` for “${q}”` : ""}
                {pageInfo.hasNextPage || pageInfo.hasPreviousPage
                  ? ""
                  : ""}
              </s-text>

              <s-box border="base" borderRadius="base" overflow="hidden">
                {customers.map((customer, index) => {
                  const isOpen = openId === customer.id;
                  const subtitle = [customer.email, customer.phone]
                    .filter(Boolean)
                    .join(" · ");

                  return (
                    <s-stack key={customer.id} direction="block" gap="none">
                      {index > 0 ? (
                        <s-box paddingInline="base">
                          <s-divider />
                        </s-box>
                      ) : null}

                      <s-clickable
                        padding="base"
                        accessibilityLabel={`${isOpen ? "Collapse" : "Expand"} details for ${fullName(customer)}`}
                        onClick={() => toggle(customer.id)}
                      >
                        <s-grid
                          gridTemplateColumns="auto 1fr auto"
                          gap="base"
                          alignItems="center"
                        >
                          {customer.customDetails.profilePicture.url ? (
                            <s-thumbnail
                              size="small"
                              src={customer.customDetails.profilePicture.url}
                              alt={fullName(customer)}
                            />
                          ) : (
                            <s-avatar
                              initials={fullName(customer)
                                .slice(0, 2)
                                .toUpperCase()}
                            />
                          )}
                          <s-stack direction="block" gap="none">
                            <s-heading>{fullName(customer)}</s-heading>
                            <s-paragraph color="subdued">
                              {subtitle || "No email / phone"}
                            </s-paragraph>
                          </s-stack>
                          <s-stack
                            direction="inline"
                            gap="small"
                            alignItems="center"
                          >
                            <MarketingBadge
                              channel="Email"
                              state={customer.emailMarketing.marketingState}
                            />
                            <MarketingBadge
                              channel="SMS"
                              state={customer.smsMarketing.marketingState}
                            />
                            <s-text color="subdued">
                              {formatDate(customer.updatedAt)}
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
                            <s-stack direction="block" gap="small">
                              <s-heading>Profile</s-heading>
                              <DetailRow
                                label="First name"
                                value={customer.firstName}
                              />
                              <DetailRow
                                label="Last name"
                                value={customer.lastName}
                              />
                              <DetailRow label="Email" value={customer.email} />
                              <DetailRow label="Phone" value={customer.phone} />
                              <DetailRow
                                label="Last updated"
                                value={formatDate(customer.updatedAt)}
                              />
                              <DetailRow
                                label="Customer ID"
                                value={customer.id}
                              />
                            </s-stack>

                            <s-divider />

                            <s-stack direction="block" gap="small">
                              <s-heading>Notifications</s-heading>
                              <DetailRow
                                label="Email updates"
                                value={`${marketingLabel(customer.emailMarketing.marketingState)}${customer.email ? ` · ${customer.email}` : ""}`}
                              />
                              <DetailRow
                                label="Phone SMS updates"
                                value={`${marketingLabel(customer.smsMarketing.marketingState)}${customer.phone ? ` · ${customer.phone}` : ""}`}
                              />
                            </s-stack>

                            <s-divider />

                            <s-stack direction="block" gap="small">
                              <s-heading>Custom details (metafields)</s-heading>
                              <s-stack direction="block" gap="small">
                                <s-text color="subdued">Profile picture</s-text>
                                {customer.customDetails.profilePicture.url ? (
                                  <s-thumbnail
                                    size="large"
                                    src={
                                      customer.customDetails.profilePicture.url
                                    }
                                    alt={fullName(customer)}
                                  />
                                ) : (
                                  <s-text>—</s-text>
                                )}
                              </s-stack>
                              <DetailRow
                                label="Date of birth"
                                value={customer.customDetails.dateOfBirth}
                              />
                              <DetailRow
                                label="Gender"
                                value={customer.customDetails.gender}
                              />
                              <DetailRow
                                label="Social handle"
                                value={
                                  customer.customDetails.socialMediaHandle
                                }
                              />
                            </s-stack>
                          </s-stack>
                        </s-box>
                      ) : null}
                    </s-stack>
                  );
                })}
              </s-box>

              <s-stack direction="inline" gap="base">
                <s-button
                  {...(!pageInfo.hasPreviousPage ? { disabled: true } : {})}
                  onClick={() =>
                    updateParams({
                      before: pageInfo.startCursor,
                      after: null,
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
                    })
                  }
                >
                  Next
                </s-button>
              </s-stack>
            </s-stack>
          )}
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
