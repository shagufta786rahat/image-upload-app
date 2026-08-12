import prisma from "./db.server";

export async function refreshOfflineToken(session) {
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
