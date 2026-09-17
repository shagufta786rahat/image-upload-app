import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loader() {
  const filePath = path.join(process.cwd(), "WISHLIST-WEBHOOKS.html");
  const html = await readFile(filePath, "utf8");
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=120",
    },
  });
}
