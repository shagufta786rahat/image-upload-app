import db from "../../db.server";

export async function loader({ request }) {
  const url = new URL(request.url);
  const customerId = url.searchParams.get("customerId");

  if (!customerId) {
    return new Response(JSON.stringify([]), {
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }

  const wishlist = await db.wishlist.findFirst({
    where: { customerId },
  });

  return new Response(
    JSON.stringify(wishlist ? wishlist.productHandle : []),
    { headers: { "Access-Control-Allow-Origin": "*" } }
  );
}
