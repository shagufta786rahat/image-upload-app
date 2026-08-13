import db from "../../db.server";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

export async function loader() {
  return new Response(
    JSON.stringify({ status: "API working — use POST" }),
    { status: 200, headers: corsHeaders }
  );
}

export async function action({ request }) {
  // --- Handle OPTIONS preflight ---
  if (request.method === "OPTIONS") {
    return new Response("OK", { status: 200, headers: corsHeaders });
  }

  try {
    const body = await request.json();
    const { actionType, productHandle, customerId } = body;

    if (!customerId) {
      return new Response(
        JSON.stringify({ error: "Missing parameters" }),
        { status: 400, headers: corsHeaders }
      );
    }

     // -------------------------------
    // 1. IF WISHLIST EMPTY → DELETE
    // -------------------------------
    //console.log(actionType,"---actionType")
    if (actionType === "remove") {
       console.log(actionType,"---actionType2");
      await db.wishlist.deleteMany({
        where: { customerId }
      });

      return new Response(
        JSON.stringify({ message: "Wishlist removed" }),
        { status: 200, headers: corsHeaders }
      );
    }

   const existing = await db.wishlist.findFirst({
      where: { customerId }
    });

    let wishlist_save;

    if (existing) {
       wishlist_save = await db.wishlist.updateMany({
        where: { customerId: customerId },
        data: { productHandle: productHandle },
      });
    } else {
      wishlist_save = await db.wishlist.create({
      data: {
        customerId,
        productHandle,
      },
    });
    }

    return new Response(
      JSON.stringify({ message: "POST OK", wishlist_save }),
      { status: 200, headers: corsHeaders }
    );

  } catch (error) {
    console.error("Wishlist error:", error);

    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: corsHeaders }
    );
  }
}
