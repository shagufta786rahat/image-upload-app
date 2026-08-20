import { jsonCors, optionsCors } from "../cors.server";
import {
  JudgeMeError,
  errorResponsePayload,
  errorStatus,
  sendManualReviewRequest,
} from "../judge-me.server";

const METHODS = "POST, OPTIONS";

export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }

  return jsonCors(
    request,
    {
      success: false,
      error: "Method not allowed. Use POST /judge-me/review-request",
    },
    405,
    METHODS,
  );
}

export async function action({ request }) {
  if (request.method === "OPTIONS") {
    return optionsCors(request, METHODS);
  }

  if (request.method !== "POST") {
    return jsonCors(
      request,
      { success: false, error: "Method not allowed" },
      405,
      METHODS,
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonCors(
      request,
      { success: false, error: "Invalid JSON body" },
      400,
      METHODS,
    );
  }

  try {
    const data = await sendManualReviewRequest(body);
    return jsonCors(request, { success: true, data }, 200, METHODS);
  } catch (error) {
    if (!(error instanceof JudgeMeError)) {
      console.error("Judge.me review request failed");
    }

    return jsonCors(
      request,
      errorResponsePayload(error, "Unable to create Judge.me review request"),
      errorStatus(error, 500),
      METHODS,
    );
  }
}
