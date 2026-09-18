const LOGISY_PRESIGNED_URL =
  "https://logisy.tech/api/return-center/config/presigned_url/third-party/";

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

export function getReturnCenterConfig() {
  return {
    apiKey: requiredEnv("LOGISY_API_KEY"),
    staffEmail:
      String(process.env.LOGISY_STAFF_EMAIL || "support@salty.co.in").trim(),
  };
}

export function normalizeOrderId(value) {
  return String(value || "").trim();
}

export function normalizeContact(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

export async function getReturnCenterSignedUrl({ orderId, contact }) {
  const { apiKey, staffEmail } = getReturnCenterConfig();
  const apiUrl = new URL(LOGISY_PRESIGNED_URL);

  apiUrl.searchParams.set("order_id", orderId);
  apiUrl.searchParams.set("contact", contact);
  apiUrl.searchParams.set("staff_email", staffEmail);

  const response = await fetch(apiUrl.toString(), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
  });

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Return Center API error: ${response.status}`);
  }

  const signedUrl = result?.data?.signed_url;
  if (!response.ok || !result?.success || !signedUrl) {
    throw new Error(
      result?.error || `Return Center API error: ${response.status}`,
    );
  }

  return signedUrl;
}
