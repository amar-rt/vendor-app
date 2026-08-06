import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { destinationAdminClient } from "../destination-admin.server";
import db from "../db.server";

const BRAND_NAMESPACE = "custom";

// ---------------------------------------------------------------------------
// Loader: list the vendor's own products, annotated with sync status against
// this shop's single destination store (configured in Settings).
// ---------------------------------------------------------------------------

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const url = new URL(request.url);
  const search = url.searchParams.get("q")?.trim() ?? "";
  const pushedOnly = url.searchParams.get("pushed") === "1";

  const destination = await db.destinationStore.findUnique({
    where: { vendorShop: shop },
  });

  // Wildcard title search; strip characters that would break Shopify's
  // search query syntax rather than trying to fully escape them.
  const sanitizedSearch = search.replace(/["*\\]/g, "");
  const queryParts = [];
  if (sanitizedSearch) queryParts.push(`title:*${sanitizedSearch}*`);
  queryParts.push("status:active");
  const searchQuery = queryParts.join(" AND ");

  const productsResponse = await admin.graphql(
    `#graphql
      query VendorProducts($query: String) {
        products(first: 25, sortKey: TITLE, query: $query) {
          edges {
            node {
              id
              title
              vendor
              status
              productType
              category { name }
              featuredImage { url altText }
              variants(first: 25) {
                edges { node { id title sku price inventoryQuantity } }
              }
            }
          }
        }
      }`,
    { variables: { query: searchQuery } },
  );
  const productsJson = await productsResponse.json();
  const products = productsJson.data!.products!.edges.map((e: any) => e.node);

  let links: Record<
    string,
    {
      id: string;
      destinationProductId: string;
      variants: { id: string; sourceVariantId: string }[];
    }
  > = {};
  if (destination) {
    const rows = await db.productLink.findMany({
      where: { vendorShop: shop, destinationShop: destination.domain },
      include: { variants: true },
    });
    links = Object.fromEntries(
      rows.map((r) => [
        r.sourceProductId,
        {
          id: r.id,
          destinationProductId: r.destinationProductId,
          variants: r.variants.map((v) => ({
            id: v.id,
            sourceVariantId: v.sourceVariantId,
          })),
        },
      ]),
    );
  }

  // "Pushed only" is our own sync state, not something Shopify's product
  // search can filter on — applied after the fact against this shop's
  // already-fetched page of products (still capped at 25, see note below).
  const filteredProducts = pushedOnly
    ? products.filter((p: any) => links[p.id])
    : products;

  return {
    shop,
    destination,
    products: filteredProducts,
    links,
    search,
    pushedOnly,
  };
};

// ---------------------------------------------------------------------------
// Action: push new products to the destination store, or update quantity on
// ones that are already linked. Both accept one or many ids for bulk use.
// ---------------------------------------------------------------------------

async function requireDestinationStore(vendorShop: string) {
  const destination = await db.destinationStore.findUnique({
    where: { vendorShop },
  });
  if (!destination) {
    throw new Response("No destination store configured", { status: 403 });
  }
  return destination;
}

type BrandRecord = {
  name: string;
  logoUrl: string | null;
  description: string | null;
  accentColor: string | null;
};

function brandMetafields(brand: {
  name: string | null;
  logoUrl: string | null;
  description: string | null;
  accentColor: string | null;
} | null) {
  if (!brand) return [];
  const fields: { key: string; value: string | null; type: string }[] = [
    { key: "brand_name", value: brand.name, type: "single_line_text_field" },
    { key: "brand_logo", value: brand.logoUrl, type: "single_line_text_field" },
    { key: "brand_description", value: brand.description, type: "multi_line_text_field" },
    { key: "brand_accent_color", value: brand.accentColor, type: "single_line_text_field" },
  ];
  return fields
    .filter((f) => f.value)
    .map((f) => ({
      namespace: BRAND_NAMESPACE,
      key: f.key,
      type: f.type,
      value: f.value as string,
    }));
}

async function pushOne(
  admin: any,
  destination: { id: string; domain: string; clientId: string; clientSecret: string },
  brand: BrandRecord | null,
  vendorShop: string,
  sourceProductId: string,
) {
  // 1. Read the full product off the vendor's own store.
  const sourceResp = await admin.graphql(
    `#graphql
      query SourceProduct($id: ID!) {
        product(id: $id) {
          title
          descriptionHtml
          productType
          vendor
          featuredImage { url altText }
          variants(first: 100) {
            edges {
              node { id title sku price inventoryQuantity }
            }
          }
        }
      }`,
    { variables: { id: sourceProductId } },
  );
  const sourceJson = await sourceResp.json();
  const sourceProduct = sourceJson.data?.product;
  if (!sourceProduct) {
    return { id: sourceProductId, ok: false, error: "Source product not found." };
  }
  const sourceVariants = sourceProduct.variants.edges.map((e: any) => e.node);

  // 2. Open an admin client for the destination store. This mints a fresh
  //    Admin API access token via the destination's custom-app client
  //    id/secret (client_credentials grant) — see destination-admin.server.ts.
  const destinationAdmin = await destinationAdminClient(destination);

  const locationResp = await destinationAdmin.graphql(
    `#graphql
      query FirstLocation {
        locations(first: 1) { edges { node { id } } }
      }`,
  );
  const locationJson = await locationResp.json();
  const destinationLocationId =
    locationJson.data?.locations?.edges?.[0]?.node?.id;
  if (!destinationLocationId) {
    return {
      id: sourceProductId,
      ok: false,
      error: "Destination store has no inventory location.",
    };
  }

  // 3. Create the product (with its first variant) on the destination,
  //    forwarding the featured image as external media Shopify will fetch
  //    and host on the destination store's own CDN.
  const createResp = await destinationAdmin.graphql(
    `#graphql
      mutation CreateProduct($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
        productCreate(product: $product, media: $media) {
          product {
            id
            variants(first: 1) { edges { node { id inventoryItem { id } } } }
          }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        product: {
          title: sourceProduct.title,
          descriptionHtml: sourceProduct.descriptionHtml,
          productType: sourceProduct.productType,
          vendor: brand?.name || sourceProduct.vendor,
          metafields: brandMetafields(brand),
        },
        media: sourceProduct.featuredImage
          ? [
              {
                originalSource: sourceProduct.featuredImage.url,
                alt: sourceProduct.featuredImage.altText ?? sourceProduct.title,
                mediaContentType: "IMAGE",
              },
            ]
          : [],
      },
    },
  );
  const createJson = await createResp.json();
  const createErrors = createJson.data?.productCreate?.userErrors;
  if (createErrors?.length) {
    return {
      id: sourceProductId,
      ok: false,
      error: createErrors.map((e: any) => e.message).join(", "),
    };
  }
  const destinationProduct = createJson.data!.productCreate!.product!;
  const defaultVariant = destinationProduct.variants.edges[0].node;

  // 4. Set price/sku on the auto-created default variant for source
  //    variant #0, then bulk-create any remaining variants.
  const [firstSource, ...restSource] = sourceVariants;

  const defaultVariantResp = await destinationAdmin.graphql(
    `#graphql
      mutation UpdateDefaultVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors { field message }
        }
      }`,
    {
      variables: {
        productId: destinationProduct.id,
        variants: [
          {
            id: defaultVariant.id,
            price: firstSource.price,
            // tracked: true is required — otherwise inventorySetQuantities
            // below silently rejects this variant with a userError.
            inventoryItem: { sku: firstSource.sku, tracked: true },
          },
        ],
      },
    },
  );
  const defaultVariantJson = await defaultVariantResp.json();
  const defaultVariantErrors =
    defaultVariantJson.data?.productVariantsBulkUpdate?.userErrors;
  if (defaultVariantErrors?.length) {
    return {
      id: sourceProductId,
      ok: false,
      error: defaultVariantErrors.map((e: any) => e.message).join(", "),
    };
  }

  const variantLinks: {
    sourceVariantId: string;
    sourceInventoryItemId: string;
    destinationVariantId: string;
    destinationInventoryItemId: string;
    sku: string | null;
    quantity: number;
  }[] = [
    {
      sourceVariantId: firstSource.id,
      sourceInventoryItemId: firstSource.id,
      destinationVariantId: defaultVariant.id,
      destinationInventoryItemId: defaultVariant.inventoryItem.id,
      sku: firstSource.sku,
      quantity: firstSource.inventoryQuantity ?? 0,
    },
  ];

  if (restSource.length > 0) {
    const bulkCreateResp = await destinationAdmin.graphql(
      `#graphql
        mutation AddVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            productVariants { id title inventoryItem { id } }
            userErrors { field message }
          }
        }`,
      {
        variables: {
          productId: destinationProduct.id,
          variants: restSource.map((v: any) => ({
            price: v.price,
            inventoryItem: { sku: v.sku, tracked: true },
            optionValues: [{ optionName: "Title", name: v.title }],
          })),
        },
      },
    );
    const bulkCreateJson = await bulkCreateResp.json();
    const bulkCreateErrors =
      bulkCreateJson.data?.productVariantsBulkCreate?.userErrors;
    if (bulkCreateErrors?.length) {
      return {
        id: sourceProductId,
        ok: false,
        error: bulkCreateErrors.map((e: any) => e.message).join(", "),
      };
    }
    const createdVariants =
      bulkCreateJson.data?.productVariantsBulkCreate?.productVariants ?? [];
    restSource.forEach((v: any, idx: number) => {
      const created = createdVariants[idx];
      if (!created) return;
      variantLinks.push({
        sourceVariantId: v.id,
        sourceInventoryItemId: v.id,
        destinationVariantId: created.id,
        destinationInventoryItemId: created.inventoryItem.id,
        sku: v.sku,
        quantity: v.inventoryQuantity ?? 0,
      });
    });
  }

  // 5. Seed destination inventory to match the source quantities. Newly
  //    created variants aren't guaranteed to be stocked at this specific
  //    location (e.g. multi-location destinations), so activate first.
  try {
    await ensureTracked(
      destinationAdmin,
      variantLinks.map((v) => v.destinationInventoryItemId),
      destinationLocationId,
    );
  } catch (err) {
    return {
      id: sourceProductId,
      ok: false,
      error: err instanceof Error ? err.message : "Could not enable inventory tracking.",
    };
  }
  const seedResp = await destinationAdmin.graphql(
    `#graphql
      mutation SeedInventory($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          userErrors { field message }
        }
      }`,
    {
      variables: {
        input: {
          name: "available",
          reason: "correction",
          ignoreCompareQuantity: true,
          quantities: variantLinks.map((v) => ({
            inventoryItemId: v.destinationInventoryItemId,
            locationId: destinationLocationId,
            quantity: v.quantity,
          })),
        },
      },
    },
  );
  const seedJson = await seedResp.json();
  if (seedJson.errors) {
    return {
      id: sourceProductId,
      ok: false,
      error: `Inventory sync failed: ${JSON.stringify(seedJson.errors)}`,
    };
  }
  const seedErrors = seedJson.data?.inventorySetQuantities?.userErrors;
  if (seedErrors?.length) {
    return {
      id: sourceProductId,
      ok: false,
      error: seedErrors.map((e: any) => e.message).join(", "),
    };
  }

  // 6. Persist the mapping so future visits show "Synced" + qty-only edits.
  await db.productLink.create({
    data: {
      destinationStoreId: destination.id,
      vendorShop,
      destinationShop: destination.domain,
      sourceProductId,
      destinationProductId: destinationProduct.id,
      destinationLocationId,
      brand: brand?.name ?? null,
      variants: {
        create: variantLinks.map((v) => ({
          sourceVariantId: v.sourceVariantId,
          sourceInventoryItemId: v.sourceInventoryItemId,
          destinationVariantId: v.destinationVariantId,
          destinationInventoryItemId: v.destinationInventoryItemId,
          sku: v.sku,
        })),
      },
    },
  });

  return { id: sourceProductId, ok: true };
}

// Inventory quantities can only be set on a tracked inventory item that is
// actually stocked (activated) at the target location — Shopify rejects the
// set-quantity call otherwise ("not tracked" / "not stocked at the
// location"), as a userError rather than a thrown exception. Products
// created before either of these was asserted explicitly may still be
// missing one or both, so every quantity sync re-asserts them first.
async function ensureTracked(
  destinationAdmin: any,
  inventoryItemIds: string[],
  locationId: string,
) {
  for (const id of inventoryItemIds) {
    const trackedResp = await destinationAdmin.graphql(
      `#graphql
        mutation EnsureTracked($id: ID!, $input: InventoryItemInput!) {
          inventoryItemUpdate(id: $id, input: $input) {
            userErrors { field message }
          }
        }`,
      { variables: { id, input: { tracked: true } } },
    );
    const trackedJson = await trackedResp.json();
    if (trackedJson.errors) {
      throw new Error(
        `Could not enable inventory tracking: ${JSON.stringify(trackedJson.errors)}`,
      );
    }
    const trackedErrors = trackedJson.data?.inventoryItemUpdate?.userErrors;
    if (trackedErrors?.length) {
      throw new Error(
        `Could not enable inventory tracking: ${trackedErrors.map((e: any) => e.message).join(", ")}`,
      );
    }

    // Best-effort: connects the item to the location so it can hold a
    // quantity there. If it's already activated, Shopify returns a
    // userError here that we don't need to treat as fatal — the quantity
    // set immediately after this is the real success/failure signal.
    await destinationAdmin.graphql(
      `#graphql
        mutation ActivateAtLocation($inventoryItemId: ID!, $locationId: ID!) {
          inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
            userErrors { field message }
          }
        }`,
      { variables: { inventoryItemId: id, locationId } },
    );
  }
}

// Bulk path: mirrors every variant of a product link to its current full
// available quantity. Used by the multi-select "Update quantity for N" bar,
// where reviewing/typing a custom amount per item isn't practical.
async function updateOne(
  admin: any,
  destination: { domain: string; clientId: string; clientSecret: string },
  vendorShop: string,
  productLinkId: string,
) {
  const productLink = await db.productLink.findFirst({
    where: { id: productLinkId, vendorShop },
    include: { variants: true },
  });
  if (!productLink) {
    return { id: productLinkId, ok: false, error: "Linked product not found." };
  }

  // Re-read current quantities from the vendor's own store.
  const sourceResp = await admin.graphql(
    `#graphql
      query CurrentQuantities($id: ID!) {
        product(id: $id) {
          variants(first: 100) {
            edges { node { id inventoryQuantity } }
          }
        }
      }`,
    { variables: { id: productLink.sourceProductId } },
  );
  const sourceJson = await sourceResp.json();
  const currentByVariant: Record<string, number> = Object.fromEntries(
    (sourceJson.data?.product?.variants?.edges ?? []).map((e: any) => [
      e.node.id,
      e.node.inventoryQuantity ?? 0,
    ]),
  );

  const destinationAdmin = await destinationAdminClient(destination);
  try {
    await ensureTracked(
      destinationAdmin,
      productLink.variants.map((v) => v.destinationInventoryItemId),
      productLink.destinationLocationId,
    );
  } catch (err) {
    return {
      id: productLinkId,
      ok: false,
      error: err instanceof Error ? err.message : "Could not enable inventory tracking.",
    };
  }
  const syncResp = await destinationAdmin.graphql(
    `#graphql
      mutation SyncInventory($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          userErrors { field message }
        }
      }`,
    {
      variables: {
        input: {
          name: "available",
          reason: "correction",
          ignoreCompareQuantity: true,
          quantities: productLink.variants.map((v) => ({
            inventoryItemId: v.destinationInventoryItemId,
            locationId: productLink.destinationLocationId,
            quantity: currentByVariant[v.sourceVariantId] ?? 0,
          })),
        },
      },
    },
  );
  const syncJson = await syncResp.json();
  if (syncJson.errors) {
    return {
      id: productLinkId,
      ok: false,
      error: `Inventory sync failed: ${JSON.stringify(syncJson.errors)}`,
    };
  }
  const syncErrors = syncJson.data?.inventorySetQuantities?.userErrors;
  if (syncErrors?.length) {
    return {
      id: productLinkId,
      ok: false,
      error: syncErrors.map((e: any) => e.message).join(", "),
    };
  }

  await db.productLink.update({
    where: { id: productLinkId },
    data: { updatedAt: new Date() },
  });

  return { id: productLinkId, ok: true };
}

// Single-variant path: lets the vendor publish a specific quantity for just
// one variant, independent of its siblings. Always re-checks the variant's
// live available count and clamps to it, regardless of what was requested.
async function updateVariantOne(
  admin: any,
  destination: { domain: string; clientId: string; clientSecret: string },
  vendorShop: string,
  variantLinkId: string,
  requestedQuantity: number,
) {
  const variantLink = await db.variantLink.findFirst({
    where: { id: variantLinkId },
    include: { productLink: true },
  });
  if (!variantLink || variantLink.productLink.vendorShop !== vendorShop) {
    return { id: variantLinkId, ok: false, error: "Linked variant not found." };
  }

  const sourceResp = await admin.graphql(
    `#graphql
      query CurrentVariantQuantity($id: ID!) {
        productVariant(id: $id) { inventoryQuantity }
      }`,
    { variables: { id: variantLink.sourceVariantId } },
  );
  const sourceJson = await sourceResp.json();
  const available = sourceJson.data?.productVariant?.inventoryQuantity ?? 0;
  const quantity = Math.min(Math.max(0, requestedQuantity), available);

  const destinationAdmin = await destinationAdminClient(destination);
  try {
    await ensureTracked(
      destinationAdmin,
      [variantLink.destinationInventoryItemId],
      variantLink.productLink.destinationLocationId,
    );
  } catch (err) {
    return {
      id: variantLinkId,
      ok: false,
      error: err instanceof Error ? err.message : "Could not enable inventory tracking.",
    };
  }
  const syncResp = await destinationAdmin.graphql(
    `#graphql
      mutation SyncVariantInventory($input: InventorySetQuantitiesInput!) {
        inventorySetQuantities(input: $input) {
          userErrors { field message }
        }
      }`,
    {
      variables: {
        input: {
          name: "available",
          reason: "correction",
          ignoreCompareQuantity: true,
          quantities: [
            {
              inventoryItemId: variantLink.destinationInventoryItemId,
              locationId: variantLink.productLink.destinationLocationId,
              quantity,
            },
          ],
        },
      },
    },
  );
  const syncJson = await syncResp.json();
  if (syncJson.errors) {
    return {
      id: variantLinkId,
      ok: false,
      error: `Inventory sync failed: ${JSON.stringify(syncJson.errors)}`,
    };
  }
  const syncErrors = syncJson.data?.inventorySetQuantities?.userErrors;
  if (syncErrors?.length) {
    return {
      id: variantLinkId,
      ok: false,
      error: syncErrors.map((e: any) => e.message).join(", "),
    };
  }

  await db.productLink.update({
    where: { id: variantLink.productLinkId },
    data: { updatedAt: new Date() },
  });

  return { id: variantLinkId, ok: true, quantity };
}

// Deletes the product on the destination store outright (not just our
// tracking of it), then drops our link so the row goes back to "Not
// pushed". Deliberately single-item only — deletion is irreversible on the
// destination side, so this isn't something to expose as a bulk action.
async function unpushOne(
  destination: { domain: string; clientId: string; clientSecret: string },
  vendorShop: string,
  productLinkId: string,
) {
  const productLink = await db.productLink.findFirst({
    where: { id: productLinkId, vendorShop },
  });
  if (!productLink) {
    return { id: productLinkId, ok: false, error: "Linked product not found." };
  }

  const destinationAdmin = await destinationAdminClient(destination);
  const deleteResp = await destinationAdmin.graphql(
    `#graphql
      mutation DeleteProduct($input: ProductDeleteInput!) {
        productDelete(input: $input) {
          deletedProductId
          userErrors { field message }
        }
      }`,
    { variables: { input: { id: productLink.destinationProductId } } },
  );
  const deleteJson = await deleteResp.json();
  if (deleteJson.errors) {
    return {
      id: productLinkId,
      ok: false,
      error: `Delete failed: ${JSON.stringify(deleteJson.errors)}`,
    };
  }
  const deleteErrors = deleteJson.data?.productDelete?.userErrors;
  if (deleteErrors?.length) {
    return {
      id: productLinkId,
      ok: false,
      error: deleteErrors.map((e: any) => e.message).join(", "),
    };
  }

  // Cascades to VariantLink rows.
  await db.productLink.delete({ where: { id: productLinkId } });

  return { id: productLinkId, ok: true };
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const vendorShop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "push") {
    const productIds = formData.getAll("productId").map(String);
    if (productIds.length === 0) {
      return { error: "No products selected." };
    }
    const destination = await requireDestinationStore(vendorShop);
    const brand = await db.brand.findUnique({ where: { shop: vendorShop } });

    const results = [];
    for (const productId of productIds) {
      results.push(
        await pushOne(admin, destination, brand, vendorShop, productId),
      );
    }

    const failed = results.filter((r) => !r.ok);
    return {
      ok: true,
      action: "push" as const,
      succeeded: results.length - failed.length,
      failed: failed.length,
      errors: failed.map((f) => f.error),
    };
  }

  if (intent === "updateQuantity") {
    const productLinkIds = formData.getAll("productLinkId").map(String);
    if (productLinkIds.length === 0) {
      return { error: "No products selected." };
    }
    const destination = await requireDestinationStore(vendorShop);

    const results = [];
    for (const productLinkId of productLinkIds) {
      results.push(await updateOne(admin, destination, vendorShop, productLinkId));
    }

    const failed = results.filter((r) => !r.ok);
    return {
      ok: true,
      action: "updateQuantity" as const,
      succeeded: results.length - failed.length,
      failed: failed.length,
      errors: failed.map((f) => f.error),
    };
  }

  if (intent === "updateVariantQuantities") {
    const variantLinkIds = formData.getAll("variantLinkId").map(String);
    const rawQuantities = formData.getAll("quantity").map(String);
    if (
      variantLinkIds.length === 0 ||
      variantLinkIds.length !== rawQuantities.length
    ) {
      return { error: "Missing variant quantities." };
    }
    const quantities = rawQuantities.map(Number);
    if (quantities.some((q) => !Number.isFinite(q) || q < 0)) {
      return { error: "Enter valid, non-negative quantities." };
    }

    const destination = await requireDestinationStore(vendorShop);

    const results = [];
    for (let i = 0; i < variantLinkIds.length; i++) {
      results.push(
        await updateVariantOne(
          admin,
          destination,
          vendorShop,
          variantLinkIds[i],
          quantities[i],
        ),
      );
    }

    const failed = results.filter((r) => !r.ok);
    return {
      ok: true,
      action: "updateVariantQuantities" as const,
      succeeded: results.length - failed.length,
      failed: failed.length,
      errors: failed.map((f) => f.error),
    };
  }

  if (intent === "unpush") {
    const productLinkId = String(formData.get("productLinkId") || "");
    if (!productLinkId) {
      return { error: "No product specified." };
    }
    const destination = await requireDestinationStore(vendorShop);
    const result = await unpushOne(destination, vendorShop, productLinkId);
    if (!result.ok) {
      return { error: result.error };
    }
    return { ok: true, action: "unpush" as const };
  }

  return { error: "Unknown action." };
};

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export default function Products() {
  const { shop, destination, products, links, search, pushedOnly } =
    useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  // Only drives the persistent top button + the bulk "update quantity" bar.
  // Per-row actions each get their own fetcher (see ProductRow) so clicking
  // one row's button doesn't show every other row as loading too.
  const bulkFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (bulkFetcher.data && "error" in bulkFetcher.data && bulkFetcher.data.error) {
      shopify.toast.show(bulkFetcher.data.error, { isError: true });
    } else if (bulkFetcher.data?.ok && bulkFetcher.data.action !== "unpush") {
      const { succeeded, failed, errors, action: actionName } = bulkFetcher.data;
      const verb = actionName === "push" ? "pushed" : "updated";
      const detail = errors?.filter(Boolean).join("; ");
      const message =
        failed > 0
          ? `${succeeded} ${verb}, ${failed} failed${detail ? `: ${detail}` : ""}`
          : `${succeeded} ${verb}`;
      shopify.toast.show(message, { isError: failed > 0 && succeeded === 0 });
      setSelected(new Set());
    }
  }, [bulkFetcher.data, shopify]);

  const isBulkBusy = bulkFetcher.state !== "idle";

  const selectableIds = useMemo(
    () => products.filter((p: any) => !links[p.id]).map((p: any) => p.id),
    [products, links],
  );
  const allSelected =
    selectableIds.length > 0 && selected.size === selectableIds.length;
  const someSelected = selected.size > 0 && !allSelected;

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(selectableIds));
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulkPush = (productIds: string[]) => {
    const formData = new FormData();
    formData.append("intent", "push");
    productIds.forEach((id) => formData.append("productId", id));
    bulkFetcher.submit(formData, { method: "post" });
  };

  const bulkUpdateQuantity = (productLinkIds: string[]) => {
    const formData = new FormData();
    formData.append("intent", "updateQuantity");
    productLinkIds.forEach((id) => formData.append("productLinkId", id));
    bulkFetcher.submit(formData, { method: "post" });
  };

  const onSearchInput = (event: any) => {
    const value = event.target.value as string;
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (value) next.set("q", value);
      else next.delete("q");
      setSearchParams(next);
    }, 400);
  };

  const togglePushedOnly = () => {
    const next = new URLSearchParams(searchParams);
    if (pushedOnly) next.delete("pushed");
    else next.set("pushed", "1");
    setSearchParams(next);
  };

  // Selected products split by whether they're already linked, so the bulk
  // bar can offer "push" for new ones and "update quantity" for synced ones.
  const selectedUnlinked = [...selected].filter((id) => !links[id]);
  const selectedLinked = [...selected]
    .map((id) => links[id])
    .filter(Boolean) as { id: string; destinationProductId: string }[];

  return (
    <s-page heading="Products" inlineSize="large">
      {!destination && (
        <s-section heading="No destination store configured">
          <s-paragraph>
            Go to <s-link href="/app/settings">Settings</s-link> to configure
            a destination store before pushing products.
          </s-paragraph>
        </s-section>
      )}

      <s-section>
        <s-heading>
          <s-text type="strong">Catalog</s-text>
          {destination && (
            <s-text> : pushing to Destination store ({destination.domain})</s-text>
          )}
        </s-heading>
        <s-stack direction="block" gap="base">
          <s-search-field
            label="Search products"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search by title…"
            defaultValue={search}
            onInput={onSearchInput}
          ></s-search-field>

          <s-stack
            direction="inline"
            gap="base"
            alignItems="center"
            justifyContent={destination ? "space-between" : "end"}
          >
            {destination && (
              <s-checkbox
                label="Pushed only"
                checked={pushedOnly}
                onChange={togglePushedOnly}
              ></s-checkbox>
            )}
            <s-button
              variant="primary"
              disabled={selected.size === 0}
              {...(isBulkBusy ? { loading: true } : {})}
              onClick={() => {
                if (selectedUnlinked.length === 0) {
                  shopify.toast.show(
                    "All selected products are already pushed",
                    { isError: true },
                  );
                  return;
                }
                bulkPush(selectedUnlinked);
              }}
            >
              Push to destination store
            </s-button>
          </s-stack>

          {destination && selectedLinked.length > 0 && (
            <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
              <s-stack direction="block" gap="small">
                <s-text color="subdued">
                  Bulk update mirrors each product’s full available quantity —
                  to publish a partial amount, update that row individually.
                </s-text>
                <s-stack direction="inline" gap="base" alignItems="center">
                  <s-text>{selected.size} selected</s-text>
                  <s-button
                    {...(isBulkBusy ? { loading: true } : {})}
                    onClick={() =>
                      bulkUpdateQuantity(selectedLinked.map((l) => l.id))
                    }
                  >
                    Update quantity for {selectedLinked.length}
                  </s-button>
                </s-stack>
              </s-stack>
            </s-box>
          )}

          <s-table variant="auto">
            <s-table-header-row>
              <s-table-header>
                {destination && selectableIds.length > 0 && (
                  <s-checkbox
                    accessibilityLabel="Select all"
                    checked={allSelected}
                    indeterminate={someSelected}
                    onChange={toggleAll}
                  ></s-checkbox>
                )}
              </s-table-header>
              <s-table-header></s-table-header>
              <s-table-header listSlot="primary">Product</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
              <s-table-header listSlot="labeled">Category</s-table-header>
              <s-table-header listSlot="labeled" format="currency">Price</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">Available</s-table-header>
              <s-table-header listSlot="inline">Destination</s-table-header>
              <s-table-header listSlot="inline">Action</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {products.map((p: any) => (
                <ProductRow
                  key={p.id}
                  shop={shop}
                  product={p}
                  link={links[p.id]}
                  hasDestination={!!destination}
                  selected={selected.has(p.id)}
                  onToggle={() => toggleOne(p.id)}
                />
              ))}
            </s-table-body>
          </s-table>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function ProductRow({
  shop,
  product,
  link,
  hasDestination,
  selected,
  onToggle,
}: {
  shop: string;
  product: any;
  link?: {
    id: string;
    destinationProductId: string;
    variants: { id: string; sourceVariantId: string }[];
  };
  hasDestination: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  // Its own fetcher, independent of every other row and the bulk actions —
  // so this row's button is the only one that shows a loading state.
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isBusy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data && "error" in fetcher.data && fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    } else if (fetcher.data?.ok && fetcher.data.action === "push") {
      if (fetcher.data.failed > 0) {
        const detail = fetcher.data.errors?.filter(Boolean).join("; ");
        shopify.toast.show(
          `Push failed${detail ? `: ${detail}` : ""}`,
          { isError: true },
        );
      } else {
        shopify.toast.show(`Pushed ${product.title}`);
      }
    }
  }, [fetcher.data, shopify, product.title]);

  const sourceVariants = product.variants.edges.map((e: any) => e.node);
  const firstVariant = sourceVariants[0];
  const category = product.category?.name ?? product.productType ?? "—";
  const productNumericId = product.id.split("/").pop();
  const adminProductUrl = `https://${shop}/admin/products/${productNumericId}`;

  const push = () => {
    const formData = new FormData();
    formData.append("intent", "push");
    formData.append("productId", product.id);
    fetcher.submit(formData, { method: "post" });
  };

  return (
    <s-table-row>
      <s-table-cell>
        {hasDestination && (
          <s-checkbox
            accessibilityLabel={`Select ${product.title}`}
            checked={selected}
            disabled={!!link}
            onChange={onToggle}
          ></s-checkbox>
        )}
      </s-table-cell>
      <s-table-cell>
        <s-thumbnail
          src={product.featuredImage?.url}
          alt={product.featuredImage?.altText ?? product.title}
          size="small"
        ></s-thumbnail>
      </s-table-cell>
      <s-table-cell>
        {/* s-link doesn't expose a style/className prop to override its
            default underlined link color, so this uses a plain anchor to
            get bold, black, non-underlined text while staying a real link. */}
        <a
          href={adminProductUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#1a1a1a", fontWeight: 700, textDecoration: "none" }}
        >
          {product.title}
        </a>
      </s-table-cell>
      <s-table-cell>
        <s-badge tone={product.status === "ACTIVE" ? "success" : "neutral"}>
          {product.status}
        </s-badge>
      </s-table-cell>
      <s-table-cell>{category}</s-table-cell>
      <s-table-cell>
        {firstVariant?.price ? `$${firstVariant.price}` : "—"}
      </s-table-cell>
      <s-table-cell>{firstVariant?.inventoryQuantity ?? 0}</s-table-cell>
      <s-table-cell>
        {!hasDestination ? (
          "—"
        ) : link ? (
          <s-badge tone="success">Pushed</s-badge>
        ) : (
          <s-badge tone="neutral">Not pushed</s-badge>
        )}
      </s-table-cell>
      <s-table-cell>
        {!hasDestination ? null : link ? (
          <div
            style={{
              display: "flex",
              flexWrap: "nowrap",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <UpdateQuantityModal
              product={product}
              sourceVariants={sourceVariants}
              link={link}
            />
            <UnpushButton product={product} link={link} />
          </div>
        ) : (
          <s-button
            {...(isBusy ? { loading: true } : {})}
            onClick={push}
          >
            Push
          </s-button>
        )}
      </s-table-cell>
    </s-table-row>
  );
}

function UpdateQuantityModal({
  product,
  sourceVariants,
  link,
}: {
  product: any;
  sourceVariants: any[];
  link: {
    id: string;
    destinationProductId: string;
    variants: { id: string; sourceVariantId: string }[];
  };
}) {
  // One fetcher for the whole modal — every variant in it is submitted
  // together as a single batch, so there's nothing else on this row to
  // conflict with while it's in flight.
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isBusy = fetcher.state !== "idle";
  const modalId = `quantity-modal-${product.id}`;
  const modalRef = useRef<any>(null);

  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      sourceVariants.map((v) => [v.id, String(v.inventoryQuantity ?? 0)]),
    ),
  );

  // The modal stays open (with a status line + disabled controls) for the
  // whole request, and only closes once we actually know it succeeded —
  // it used to close the instant "Save" was clicked, before the request to
  // the destination store had even finished, so failures went unnoticed.
  useEffect(() => {
    if (fetcher.data && "error" in fetcher.data && fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    } else if (fetcher.data?.ok && fetcher.data.action !== "unpush") {
      const { succeeded, failed, errors } = fetcher.data;
      const detail = errors?.filter(Boolean).join("; ");
      shopify.toast.show(
        failed > 0
          ? `${succeeded} variant(s) updated, ${failed} failed${detail ? `: ${detail}` : ""}`
          : `Updated ${product.title}`,
        { isError: failed > 0 && succeeded === 0 },
      );
      if (failed === 0) {
        modalRef.current?.hideOverlay?.();
      }
    }
  }, [fetcher.data, shopify, product.title]);

  const saveAll = () => {
    const formData = new FormData();
    formData.append("intent", "updateVariantQuantities");

    for (const v of sourceVariants) {
      const variantLink = link.variants.find(
        (vl) => vl.sourceVariantId === v.id,
      );
      if (!variantLink) continue;

      const available = v.inventoryQuantity ?? 0;
      const requested = Number(quantities[v.id]);
      if (!Number.isFinite(requested) || requested < 0) {
        shopify.toast.show(
          `Enter a valid quantity for ${v.title}`,
          { isError: true },
        );
        return;
      }
      if (requested > available) {
        shopify.toast.show(
          `${v.title} can't exceed available quantity (${available})`,
          { isError: true },
        );
        return;
      }

      formData.append("variantLinkId", variantLink.id);
      formData.append("quantity", String(requested));
    }

    fetcher.submit(formData, { method: "post" });
  };

  return (
    <>
      <s-button commandFor={modalId} command="--show">
        Update quantity
      </s-button>
      <s-modal
        id={modalId}
        heading={`Update quantity — ${product.title}`}
        ref={modalRef}
      >
        <s-button
          slot="primary-action"
          variant="primary"
          disabled={isBusy}
          {...(isBusy ? { loading: true } : {})}
          onClick={saveAll}
        >
          Save changes
        </s-button>
        <s-button slot="secondary-actions" disabled={isBusy} command="--hide" commandFor={modalId}>
          Cancel
        </s-button>
        <s-stack direction="block" gap="base">
          {isBusy && (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-spinner accessibilityLabel="Saving" size="base"></s-spinner>
              <s-text color="subdued">
                Publishing quantities to the destination store…
              </s-text>
            </s-stack>
          )}
          {sourceVariants.map((v) => (
            <s-stack key={v.id} direction="inline" gap="base" alignItems="center">
              <s-text>
                {v.title} — SKU: {v.sku || "—"}
              </s-text>
              <s-number-field
                label={`Quantity — ${v.title}`}
                labelAccessibilityVisibility="exclusive"
                value={quantities[v.id]}
                min={0}
                max={v.inventoryQuantity ?? 0}
                disabled={isBusy}
                onInput={(e: any) =>
                  setQuantities((prev) => ({ ...prev, [v.id]: e.target.value }))
                }
              ></s-number-field>
              <s-text color="subdued">/ {v.inventoryQuantity ?? 0} available</s-text>
            </s-stack>
          ))}
        </s-stack>
      </s-modal>
    </>
  );
}

function UnpushButton({
  product,
  link,
}: {
  product: any;
  link: { id: string; destinationProductId: string };
}) {
  // Its own fetcher — deleting one product's own row never affects any
  // other row's loading state.
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const isBusy = fetcher.state !== "idle";
  const modalId = `unpush-modal-${product.id}`;
  const modalRef = useRef<any>(null);

  useEffect(() => {
    if (fetcher.data && "error" in fetcher.data && fetcher.data.error) {
      shopify.toast.show(fetcher.data.error, { isError: true });
    } else if (fetcher.data?.ok) {
      shopify.toast.show(`Deleted ${product.title} from the destination store`);
      modalRef.current?.hideOverlay?.();
    }
  }, [fetcher.data, shopify, product.title]);

  const confirmDelete = () => {
    const formData = new FormData();
    formData.append("intent", "unpush");
    formData.append("productLinkId", link.id);
    fetcher.submit(formData, { method: "post" });
  };

  return (
    <>
      <s-button
        icon="delete"
        tone="critical"
        variant="tertiary"
        accessibilityLabel="Delete from destination store"
        commandFor={modalId}
        command="--show"
      ></s-button>
      <s-modal
        id={modalId}
        heading={`Delete ${product.title}?`}
        ref={modalRef}
      >
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          disabled={isBusy}
          {...(isBusy ? { loading: true } : {})}
          onClick={confirmDelete}
        >
          Delete from destination store
        </s-button>
        <s-button slot="secondary-actions" disabled={isBusy} command="--hide" commandFor={modalId}>
          Cancel
        </s-button>
        <s-paragraph>
          This permanently deletes <s-text>{product.title}</s-text> — along
          with all of its variants, images, and inventory records — from
          your destination store. This can’t be undone. Your own store’s
          product is not affected.
        </s-paragraph>
      </s-modal>
    </>
  );
}
