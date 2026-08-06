import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { destinationAdminClient } from "../destination-admin.server";
import db from "../db.server";

function normalizeShopDomain(input: string) {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  const withDomain = trimmed.includes(".") ? trimmed : `${trimmed}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(withDomain)
    ? withDomain
    : null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [destination, brand] = await Promise.all([
    db.destinationStore.findUnique({ where: { vendorShop: shop } }),
    db.brand.findUnique({ where: { shop } }),
  ]);

  return { shop, destination, brand };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "saveDestination") {
    const domain = normalizeShopDomain(String(formData.get("domain") || ""));
    const clientId = String(formData.get("clientId") || "").trim();
    const clientSecret = String(formData.get("clientSecret") || "").trim();

    if (!domain) {
      return { error: "Enter a valid *.myshopify.com domain." };
    }
    if (domain === shop) {
      return { error: "You can't connect a store to itself." };
    }
    if (!clientId || !clientSecret) {
      return { error: "Client ID and Client Secret are both required." };
    }

    // Confirm the credentials actually work before saving them.
    try {
      const client = await destinationAdminClient({
        domain,
        clientId,
        clientSecret,
      });
      const resp = await client.graphql(`#graphql
        query VerifyAccess { shop { name } }
      `);
      const json = await resp.json();
      if (json.errors) {
        return {
          error: `Destination store rejected the credentials: ${JSON.stringify(json.errors)}`,
        };
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Could not verify credentials." };
    }

    await db.destinationStore.upsert({
      where: { vendorShop: shop },
      update: { domain, clientId, clientSecret },
      create: { vendorShop: shop, domain, clientId, clientSecret },
    });

    return { ok: true };
  }

  if (intent === "removeDestination") {
    // Cascades to ProductLink/VariantLink rows for that destination.
    await db.destinationStore.deleteMany({ where: { vendorShop: shop } });
    return { ok: true };
  }

  if (intent === "testConnection") {
    const destination = await db.destinationStore.findUnique({
      where: { vendorShop: shop },
    });
    if (!destination) {
      return { error: "No destination store configured yet." };
    }
    try {
      const client = await destinationAdminClient(destination);
      const resp = await client.graphql(`#graphql
        query VerifyAccess { shop { name } }
      `);
      const json = await resp.json();
      if (json.errors) {
        return { error: `Request failed: ${JSON.stringify(json.errors)}` };
      }
      return { ok: true, shopName: json.data?.shop?.name };
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Test failed." };
    }
  }

  if (intent === "uploadLogo") {
    const file = formData.get("logoFile");
    if (!(file instanceof File) || file.size === 0) {
      return { error: "No file selected." };
    }
    if (!file.type.startsWith("image/")) {
      return { error: "Please upload an image file." };
    }

    // 1. Ask Shopify (on our own shop) for a place to upload the raw bytes.
    const stagedResp = await admin.graphql(
      `#graphql
        mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
          stagedUploadsCreate(input: $input) {
            stagedTargets { url resourceUrl parameters { name value } }
            userErrors { field message }
          }
        }`,
      {
        variables: {
          input: [
            {
              filename: file.name,
              mimeType: file.type,
              httpMethod: "POST",
              resource: "IMAGE",
              fileSize: String(file.size),
            },
          ],
        },
      },
    );
    const stagedJson = await stagedResp.json();
    const stagedErrors = stagedJson.data?.stagedUploadsCreate?.userErrors;
    if (stagedErrors?.length) {
      return { error: stagedErrors.map((e: any) => e.message).join(", ") };
    }
    const target = stagedJson.data?.stagedUploadsCreate?.stagedTargets?.[0];
    if (!target) {
      return { error: "Could not start the upload." };
    }

    // 2. Upload the raw bytes to that (external, pre-signed) URL.
    const uploadForm = new FormData();
    target.parameters.forEach((p: { name: string; value: string }) =>
      uploadForm.append(p.name, p.value),
    );
    uploadForm.append("file", file);
    const uploadResp = await fetch(target.url, {
      method: "POST",
      body: uploadForm,
    });
    if (!uploadResp.ok) {
      return { error: `Upload to storage failed (${uploadResp.status}).` };
    }

    // 3. Register the upload as a File so Shopify hosts + serves it.
    const fileCreateResp = await admin.graphql(
      `#graphql
        mutation FileCreate($files: [FileCreateInput!]!) {
          fileCreate(files: $files) {
            files { id preview { image { url } } }
            userErrors { field message }
          }
        }`,
      {
        variables: {
          files: [
            {
              alt: "Brand logo",
              contentType: "IMAGE",
              originalSource: target.resourceUrl,
            },
          ],
        },
      },
    );
    const fileCreateJson = await fileCreateResp.json();
    const fileCreateErrors = fileCreateJson.data?.fileCreate?.userErrors;
    if (fileCreateErrors?.length) {
      return { error: fileCreateErrors.map((e: any) => e.message).join(", ") };
    }
    const created = fileCreateJson.data?.fileCreate?.files?.[0];
    let logoUrl = created?.preview?.image?.url ?? null;

    // Image processing is async; give it one short chance to finish.
    if (!logoUrl && created?.id) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const refetch = await admin.graphql(
        `#graphql
          query FilePreview($id: ID!) {
            node(id: $id) {
              ... on MediaImage { preview { image { url } } }
            }
          }`,
        { variables: { id: created.id } },
      );
      const refetchJson = await refetch.json();
      logoUrl = refetchJson.data?.node?.preview?.image?.url ?? null;
    }

    if (!logoUrl) {
      return {
        error:
          "Upload succeeded but the image isn't ready yet — wait a moment and try again.",
      };
    }

    // Just stages the file and hands back its CDN URL — persisting it
    // against a specific brand happens via saveBrand, same as every other
    // field, so this works identically whether the brand already exists or
    // is still an unsaved draft.
    return { ok: true, logoUrl };
  }

  if (intent === "saveBrand") {
    const name = String(formData.get("name") || "").trim();
    const logoUrl = String(formData.get("logoUrl") || "").trim() || null;
    const description =
      String(formData.get("description") || "").trim() || null;
    const accentColor =
      String(formData.get("accentColor") || "").trim() || null;
    const callbackUrl =
      String(formData.get("callbackUrl") || "").trim() || null;

    if (!name) {
      return { error: "Brand name is required." };
    }

    await db.brand.upsert({
      where: { shop },
      update: { name, logoUrl, description, accentColor, callbackUrl },
      create: { shop, name, logoUrl, description, accentColor, callbackUrl },
    });

    return { ok: true };
  }

  if (intent === "deleteBrand") {
    await db.brand.deleteMany({ where: { shop } });
    return { ok: true };
  }

  return { error: "Unknown action." };
};

export default function Settings() {
  const { destination, brand } = useLoaderData<typeof loader>();
  const destinationFetcher = useFetcher<typeof action>();
  const testFetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();

  useEffect(() => {
    if (destinationFetcher.data && "error" in destinationFetcher.data) {
      shopify.toast.show(destinationFetcher.data.error!, { isError: true });
    } else if (destinationFetcher.data?.ok) {
      shopify.toast.show("Saved");
    }
  }, [destinationFetcher.data, shopify]);

  useEffect(() => {
    if (testFetcher.data && "error" in testFetcher.data) {
      shopify.toast.show(testFetcher.data.error!, { isError: true });
    } else if (testFetcher.data?.ok) {
      shopify.toast.show(
        `Connected — destination store name: ${testFetcher.data.shopName ?? "unknown"}`,
      );
    }
  }, [testFetcher.data, shopify]);

  const isSavingDestination = destinationFetcher.state !== "idle";
  const isTesting = testFetcher.state !== "idle";

  return (
    <s-page heading="Settings">
      <s-section heading="Destination store">
        <s-paragraph>
          The destination merchant creates a custom app in their own store
          (Settings → Apps and sales channels → Develop apps), grants it the
          scopes below, and gives you its Client ID and Client Secret. We use
          those to mint an Admin API access token whenever we need to read or
          write their catalog — no further approval step on their side.
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>read_products / write_products</s-list-item>
          <s-list-item>read_inventory / write_inventory</s-list-item>
          <s-list-item>read_locations</s-list-item>
          <s-list-item>write_files (for forwarding product images)</s-list-item>
          <s-list-item>
            read_publications / write_publications (to publish pushed
            products to the Online Store channel)
          </s-list-item>
        </s-unordered-list>
        <s-paragraph color="subdued">
          A missing scope here doesn’t show up as a clear permission error —
          Shopify returns a generic “doesn’t exist” message on whichever
          mutation needs it (most commonly write_inventory, on the
          inventory-tracking step of a push).
        </s-paragraph>

        {destination && (
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-text>{destination.domain}</s-text>
              <s-badge tone="success">Configured</s-badge>
              <s-button
                {...(isTesting ? { loading: true } : {})}
                onClick={() =>
                  testFetcher.submit(
                    { intent: "testConnection" },
                    { method: "post" },
                  )
                }
              >
                Test connection
              </s-button>
              <s-button
                variant="tertiary"
                {...(isSavingDestination ? { loading: true } : {})}
                onClick={() =>
                  destinationFetcher.submit(
                    { intent: "removeDestination" },
                    { method: "post" },
                  )
                }
              >
                Remove
              </s-button>
            </s-stack>
          </s-box>
        )}

        <destinationFetcher.Form method="post">
          <input type="hidden" name="intent" value="saveDestination" />
          <s-stack direction="block" gap="base">
            <s-text-field
              name="domain"
              label="Destination store domain"
              placeholder="retailer-store.myshopify.com"
              defaultValue={destination?.domain ?? ""}
            ></s-text-field>
            <s-text-field
              name="clientId"
              label="Client ID"
              defaultValue={destination?.clientId ?? ""}
            ></s-text-field>
            <s-password-field
              name="clientSecret"
              label="Client Secret"
              defaultValue={destination?.clientSecret ?? ""}
            ></s-password-field>
            <s-button
              type="submit"
              variant="primary"
              {...(isSavingDestination ? { loading: true } : {})}
            >
              {destination ? "Update credentials" : "Connect destination store"}
            </s-button>
          </s-stack>
        </destinationFetcher.Form>
      </s-section>

      <s-section heading="Brand">
        <s-paragraph>
          Sent as metafields on every product you push to the destination
          store.
        </s-paragraph>

        <s-stack direction="block" gap="base">
          <BrandCard brand={brand ?? undefined} />
        </s-stack>
      </s-section>
    </s-page>
  );
}

function BrandCard({
  brand,
}: {
  brand?: {
    name: string;
    logoUrl: string | null;
    description: string | null;
    accentColor: string | null;
    callbackUrl: string | null;
  };
}) {
  const shopify = useAppBridge();
  const saveFetcher = useFetcher<typeof action>();
  const deleteFetcher = useFetcher<typeof action>();
  const logoFetcher = useFetcher<typeof action>();
  const [isEditing, setIsEditing] = useState(!brand);
  const [logoUrl, setLogoUrl] = useState(brand?.logoUrl ?? "");
  const [isDraggingLogo, setIsDraggingLogo] = useState(false);
  const logoFileInput = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  const isSaving = saveFetcher.state !== "idle";
  const isDeleting = deleteFetcher.state !== "idle";
  const isUploadingLogo = logoFetcher.state !== "idle";

  useEffect(() => {
    if (saveFetcher.data && "error" in saveFetcher.data) {
      shopify.toast.show(saveFetcher.data.error!, { isError: true });
    } else if (saveFetcher.data?.ok) {
      shopify.toast.show("Brand saved");
      setIsEditing(false);
    }
  }, [saveFetcher.data, shopify]);

  useEffect(() => {
    if (deleteFetcher.data && "error" in deleteFetcher.data) {
      shopify.toast.show(deleteFetcher.data.error!, { isError: true });
    } else if (deleteFetcher.data?.ok) {
      shopify.toast.show("Brand deleted");
    }
  }, [deleteFetcher.data, shopify]);

  useEffect(() => {
    if (logoFetcher.data && "error" in logoFetcher.data && logoFetcher.data.error) {
      shopify.toast.show(logoFetcher.data.error, { isError: true });
    } else if (logoFetcher.data?.ok) {
      setLogoUrl(logoFetcher.data.logoUrl ?? "");
    }
  }, [logoFetcher.data, shopify]);

  const uploadLogoFile = (file: File | undefined | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      shopify.toast.show("Please choose an image file", { isError: true });
      return;
    }
    const formData = new FormData();
    formData.append("intent", "uploadLogo");
    formData.append("logoFile", file);
    logoFetcher.submit(formData, {
      method: "post",
      encType: "multipart/form-data",
    });
  };

  if (!isEditing && brand) {
    return (
      <s-box padding="base" borderWidth="base" borderRadius="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          {brand.logoUrl ? (
            <s-thumbnail src={brand.logoUrl} alt={brand.name} size="base"></s-thumbnail>
          ) : (
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            ></s-box>
          )}
          <s-stack direction="block" gap="small-200">
            <s-text>{brand.name}</s-text>
            {brand.description && (
              <s-text color="subdued">{brand.description}</s-text>
            )}
            {brand.callbackUrl && (
              <s-link href={brand.callbackUrl} target="_blank">
                {brand.callbackUrl}
              </s-link>
            )}
          </s-stack>
          <s-button onClick={() => setIsEditing(true)}>Edit</s-button>
          <s-button
            variant="tertiary"
            tone="critical"
            {...(isDeleting ? { loading: true } : {})}
            onClick={() =>
              deleteFetcher.submit(
                { intent: "deleteBrand" },
                { method: "post" },
              )
            }
          >
            Delete
          </s-button>
        </s-stack>
      </s-box>
    );
  }

  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <saveFetcher.Form method="post">
        <input type="hidden" name="intent" value="saveBrand" />
        <input type="hidden" name="logoUrl" value={logoUrl} />
        <s-stack direction="block" gap="base">
          <s-text-field
            name="name"
            label="Brand name"
            defaultValue={brand?.name ?? ""}
          ></s-text-field>

          <div
            role="button"
            tabIndex={0}
            onClick={() => !logoUrl && logoFileInput.current?.click()}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !logoUrl) {
                e.preventDefault();
                logoFileInput.current?.click();
              }
            }}
            onDragEnter={(e) => {
              e.preventDefault();
              dragCounter.current += 1;
              setIsDraggingLogo(true);
            }}
            onDragOver={(e) => e.preventDefault()}
            onDragLeave={(e) => {
              e.preventDefault();
              dragCounter.current -= 1;
              if (dragCounter.current <= 0) {
                dragCounter.current = 0;
                setIsDraggingLogo(false);
              }
            }}
            onDrop={(e) => {
              e.preventDefault();
              dragCounter.current = 0;
              setIsDraggingLogo(false);
              uploadLogoFile(e.dataTransfer.files?.[0]);
            }}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "8px",
              padding: "24px",
              minHeight: "120px",
              border: `2px dashed ${isDraggingLogo ? "#1a73e8" : "#c9cccf"}`,
              borderRadius: "8px",
              cursor: logoUrl ? "default" : "pointer",
              background: isDraggingLogo ? "rgba(26,115,232,0.06)" : undefined,
              transition: "border-color 120ms ease, background 120ms ease",
            }}
          >
            <input
              ref={logoFileInput}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => uploadLogoFile(e.target.files?.[0])}
            />

            {isUploadingLogo ? (
              <>
                <s-spinner accessibilityLabel="Uploading logo" size="base"></s-spinner>
                <s-text color="subdued">Uploading…</s-text>
              </>
            ) : logoUrl ? (
              <>
                <s-thumbnail src={logoUrl} alt="Brand logo" size="large"></s-thumbnail>
                <s-stack direction="inline" gap="base">
                  <s-button
                    variant="tertiary"
                    onClick={(e: any) => {
                      e.stopPropagation();
                      logoFileInput.current?.click();
                    }}
                  >
                    Replace
                  </s-button>
                  <s-button
                    variant="tertiary"
                    tone="critical"
                    onClick={(e: any) => {
                      e.stopPropagation();
                      setLogoUrl("");
                    }}
                  >
                    Remove
                  </s-button>
                </s-stack>
              </>
            ) : (
              <>
                <s-icon type="upload" color="subdued"></s-icon>
                <s-text color="subdued">
                  Drag and drop a logo here, or click to browse
                </s-text>
              </>
            )}
          </div>

          <s-text-field
            name="description"
            label="Description"
            defaultValue={brand?.description ?? ""}
          ></s-text-field>
          <s-url-field
            name="callbackUrl"
            label="Callback URL"
            placeholder="https://your-brand-site.com"
            autocomplete="url"
            defaultValue={brand?.callbackUrl ?? ""}
          ></s-url-field>
          <s-color-field
            name="accentColor"
            label="Accent color"
            defaultValue={brand?.accentColor ?? ""}
          ></s-color-field>

          <s-stack direction="inline" gap="base">
            <s-button
              type="submit"
              variant="primary"
              {...(isSaving ? { loading: true } : {})}
            >
              {brand ? "Save brand" : "Create brand"}
            </s-button>
            {brand && (
              <s-button variant="tertiary" onClick={() => setIsEditing(false)}>
                Cancel
              </s-button>
            )}
          </s-stack>
        </s-stack>
      </saveFetcher.Form>
    </s-box>
  );
}
