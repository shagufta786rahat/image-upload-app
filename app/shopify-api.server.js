import prisma from "./db.server";
import { refreshOfflineToken } from "./refresh-token.server";

const API_VERSION = "2026-01";

export async function getOfflineSession(shop) {
  const session = await prisma.session.findFirst({
    where: { shop, isOnline: false },
  });

  if (!session?.accessToken) {
    return null;
  }

  let accessToken = session.accessToken;
  if (
    session.expires &&
    new Date(session.expires).getTime() < Date.now() + 5 * 60 * 1000
  ) {
    accessToken = await refreshOfflineToken(session);
  }

  return { session, accessToken };
}

export async function shopifyGraphql(shop, accessToken, query, variables) {
  let res = await fetch(
    `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );

  if (res.status === 401) {
    const session = await prisma.session.findFirst({
      where: { shop, isOnline: false },
    });
    if (!session?.refreshToken) {
      throw new Error("Unauthorized and no refresh token available");
    }
    const newToken = await refreshOfflineToken(session);
    res = await fetch(
      `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": newToken,
        },
        body: JSON.stringify({ query, variables }),
      },
    );
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
