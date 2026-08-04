import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [destination, linkedProducts] = await Promise.all([
    db.destinationStore.findUnique({ where: { vendorShop: shop } }),
    db.productLink.count({ where: { vendorShop: shop } }),
  ]);

  return { destination, linkedProducts };
};

export default function Index() {
  const { destination, linkedProducts } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Vendor sync">
      <s-section heading="Overview">
        <s-stack direction="inline" gap="large">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Destination store</s-text>
              <s-heading>{destination ? destination.domain : "Not set"}</s-heading>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small">
              <s-text color="subdued">Products pushed</s-text>
              <s-heading>{linkedProducts}</s-heading>
            </s-stack>
          </s-box>
        </s-stack>
      </s-section>

      <s-section heading="Get started">
        <s-unordered-list>
          <s-list-item>
            Go to <s-link href="/app/settings">Settings</s-link> to configure
            your destination store’s Client ID/Secret and your brand profile.
          </s-list-item>
          <s-list-item>
            Then go to <s-link href="/app/products">Products</s-link> to push
            items and keep their quantities in sync.
          </s-list-item>
        </s-unordered-list>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
