import { apiVersion } from "./shopify.server";

// Shopify only supports the OAuth client_credentials grant for custom apps
// that a merchant created directly in their own store admin (Settings > Apps
// > Develop apps). Creating that app *is* the merchant's consent, so unlike
// public/custom-distribution apps there's no separate authorize redirect —
// the client id + secret alone are enough to mint an access token on demand.
async function fetchAccessToken(
  domain: string,
  clientId: string,
  clientSecret: string,
) {
  const response = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Could not get an access token for ${domain} (${response.status}): ${body}`,
    );
  }

  const json = (await response.json()) as { access_token: string };
  return json.access_token;
}

// Mirrors the shape of `admin.graphql(query, options)` from
// @shopify/shopify-app-react-router, so call sites don't need to change.
export async function destinationAdminClient(destinationStore: {
  domain: string;
  clientId: string;
  clientSecret: string;
}) {
  const accessToken = await fetchAccessToken(
    destinationStore.domain,
    destinationStore.clientId,
    destinationStore.clientSecret,
  );

  return {
    graphql: (query: string, options?: { variables?: Record<string, unknown> }) =>
      fetch(
        `https://${destinationStore.domain}/admin/api/${apiVersion}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": accessToken,
          },
          body: JSON.stringify({
            query,
            variables: options?.variables,
          }),
        },
      ),
  };
}
