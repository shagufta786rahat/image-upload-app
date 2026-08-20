export function getCorsOrigin(request) {
  return request.headers.get("origin") || "*";
}

export function corsHeaders(request, methods = "GET, POST, PUT, OPTIONS") {
  const origin = getCorsOrigin(request);
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers":
      "Content-Type, Accept, Origin, X-Requested-With, X-Shopify-Shop-Domain",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function jsonCors(request, data, status = 200, methods, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(request, methods),
      ...extraHeaders,
    },
  });
}

export function optionsCors(request, methods) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, methods),
  });
}
