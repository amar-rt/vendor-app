import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

// Mandatory compliance webhook for public apps.
// This app never stores customer PII, so there is nothing to redact.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  return new Response();
};
