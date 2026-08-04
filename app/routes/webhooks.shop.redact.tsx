import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

// Mandatory compliance webhook for public apps, sent 48h after uninstall.
// Erase any remaining shop-scoped data (app/uninstalled already cleans up
// most of it, but this is the durable guarantee Shopify requires).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await db.session.deleteMany({ where: { shop } });
  await db.destinationStore.deleteMany({ where: { vendorShop: shop } });
  await db.brand.deleteMany({ where: { shop } });

  return new Response();
};
