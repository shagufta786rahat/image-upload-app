import { wishlistCustomWebhookRoutes, WISHLIST_EVENTS } from "../wishlist-webhooks.server";

const routes = wishlistCustomWebhookRoutes(WISHLIST_EVENTS.cleared);
export const loader = routes.loader;
export const action = routes.action;
