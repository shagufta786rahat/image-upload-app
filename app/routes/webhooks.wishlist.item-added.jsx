import { wishlistCustomWebhookRoutes, WISHLIST_EVENTS } from "../wishlist-webhooks.server";

const routes = wishlistCustomWebhookRoutes(WISHLIST_EVENTS.item_added);
export const loader = routes.loader;
export const action = routes.action;
