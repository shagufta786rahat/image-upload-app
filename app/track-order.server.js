const DEFAULT_TRACKING_URL =
  "https://api.gokwik.co/kwikship/track/merchant/tracking";

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

export function getTrackOrderConfig() {
  const token = requiredEnv("GOKWIK_TRACKING_TOKEN");
  return {
    apiUrl: String(process.env.GOKWIK_TRACKING_URL || DEFAULT_TRACKING_URL).trim(),
    token: token.startsWith("Bearer ") ? token : "Bearer " + token,
  };
}

export function normalizeOrderId(value) {
  return String(value || "").trim();
}

export async function fetchTrackingPayload(orderId) {
  const { apiUrl, token } = getTrackOrderConfig();

  const response = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
    },
    body: JSON.stringify({ order_id: String(orderId) }),
  });

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Tracking API failed: " + response.status);
  }

  if (!response.ok) {
    throw new Error(
      payload?.error || payload?.message || "Tracking API failed: " + response.status,
    );
  }

  return payload;
}
