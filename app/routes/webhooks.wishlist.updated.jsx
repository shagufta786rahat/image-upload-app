import { wishlistCustomWebhookRoutes, WISHLIST_EVENTS } from "../wishlist-webhooks.server";

const routes = wishlistCustomWebhookRoutes(WISHLIST_EVENTS.updated);
export const loader = routes.loader;
export const action = routes.action;
