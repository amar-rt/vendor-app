# Vendor Sync — App Walkthrough

This is a screen-by-screen reference for the app: what each screen shows, every control on it, and the common flows a vendor merchant follows. It reflects the app exactly as implemented — no aspirational or planned features.

## What the app does

A vendor store pushes its own product catalog into a **destination store's** catalog — one destination per vendor install — carrying over images, price, and a brand profile (logo, description, accent color) as metafields. Once a product is pushed, its inventory can be kept in sync (in full or partial amounts) without ever exceeding what the vendor actually has on hand.

There is no OAuth install or approval step on the destination side. The destination merchant creates a **custom app** in their own store admin (Settings → Apps and sales channels → Develop apps) and hands the vendor its Client ID and Client Secret — creating that app *is* their consent. The vendor app uses those credentials to mint a fresh Admin API access token on demand (OAuth `client_credentials` grant) whenever it needs to read or write the destination catalog.

Three screens, reachable from the top nav on every page: **Home**, **Products**, **Settings**.

---

## Screen: Home (`/app`)

The landing dashboard. Two things live here: a quick status overview, and a two-step "get started" pointer for first-time use.

**Overview** section — two side-by-side stat boxes:

| Box | Shows |
|---|---|
| Destination store | The connected destination's domain, or **"Not set"** if none is configured yet |
| Products pushed | Count of products currently linked to the destination |

**Get started** section — a two-item checklist:
1. Go to **Settings** to configure the destination store's Client ID/Secret and the brand profile.
2. Go to **Products** to push items and keep their quantities in sync.

Home has no forms or actions of its own — it's purely a status view with links into the other two screens.

---

## Screen: Settings (`/app/settings`)

Two independent sections: **Destination store** and **Brand profile**. Neither depends on the other to be filled in first, but pushing products requires the destination store to be configured.

### Destination store

Explains the model in-page: the destination merchant creates their own custom app and shares its credentials — no approval step on their side.

**If a destination is already configured**, a summary box appears above the form:
- Destination domain (e.g. `retailer-store.myshopify.com`)
- **Configured** badge (green)
- **Test connection** button — round-trips a live GraphQL query against the destination to confirm the credentials still work. Success: toast showing the destination's actual shop name. Failure: toast with the specific error.
- **Remove** button — deletes the destination store record. This cascades: every product link and variant link to that destination is deleted too (the destination's own catalog is untouched — only our tracking of what's linked goes away).

**The form** (used to connect a destination for the first time, or update its credentials):

| Field | Notes |
|---|---|
| Destination store domain | Must resolve to a valid `*.myshopify.com` domain; can't be the vendor's own store |
| Client ID | Required |
| Client Secret | Required (password field, masked) |

Submitting **live-verifies** the credentials against the destination before saving — if they don't work, nothing is saved and you get the real rejection reason back. The submit button reads **"Connect destination store"** the first time, **"Update credentials"** after that.

### Brand profile

Everything here is sent as metafields (`custom.brand_name`, `custom.brand_logo`, `custom.brand_description`, `custom.brand_accent_color`) on every product pushed to the destination.

| Field | Notes |
|---|---|
| Brand name | Plain text, optional |
| Logo | Drag-and-drop upload (see below) — no manual URL field |
| Description | Plain text, optional |
| Accent color (hex) | e.g. `#1a73e8`, optional |

**Logo dropzone behavior:**
- Empty: upload icon + "Drag and drop your logo here, or click to browse." Click anywhere in the box, or drop an image file onto it.
- Uploading: spinner + "Uploading…" — the file is staged and hosted on Shopify's own CDN (`stagedUploadsCreate` → upload → `fileCreate`), then the resulting URL is saved.
- Has a logo: large preview thumbnail + **Replace** (pick a new file) and **Remove** (tone: critical — clears it).
- Only image files are accepted; anything else is rejected with a toast before it's even uploaded.

Click **Save brand profile** to persist name/description/accent color together (the logo saves itself immediately on upload/remove, independent of this button).

---

## Screen: Products (`/app/products`)

The main working screen: your own catalog, annotated with sync status against the destination, with search, filters, single-row and bulk actions.

If no destination is configured yet, the whole catalog is still browsable but every push/update control is hidden, with a banner pointing you to Settings.

### Toolbar

- **Push to destination store** button (top-left, primary) — always visible, disabled until you select at least one row. Pushes every *unpushed* product currently selected. If everything selected is already pushed, it tells you so instead of doing nothing silently.
- **Search products** field — type a product title; search is debounced (400ms) and re-queries Shopify server-side (`title:*your text*`), not just filtering what's already on screen.

### Filters

- **Active only** — restricts the query to `status:active` products.
- **Pushed only** (only shown once a destination is configured) — shows just the products already linked to the destination.

> Both filters apply within the first 25 products fetched (title-sorted) — there's no pagination yet, so on a catalog bigger than that, "Pushed only" may not surface everything that's actually pushed if it falls outside that window.

### Bulk update bar

Appears only when your selection includes at least one already-pushed product. Shows how many are selected and an **Update quantity for N** button — this mirrors each selected product's variants to their **full** current available quantity. It does not let you dial in a partial amount per item; for that, use the per-row modal (below).

### The catalog table

| Column | Content |
|---|---|
| (checkbox) | Row selection; header checkbox selects/deselects all (supports an indeterminate state when some but not all rows are selected) |
| (image) | Product thumbnail, or a placeholder box if the product has none |
| Product | Title |
| Status | Badge — green for `ACTIVE`, neutral for anything else (`DRAFT`, `ARCHIVED`, …) |
| Category | Shopify's standardized category name, falling back to product type, or `—` |
| Price | First variant's price |
| Available | First variant's inventory quantity |
| Destination | `—` with no destination configured; otherwise a **Pushed** (green) or **Not pushed** (neutral) badge |
| Action | See below |

**Action column:**
- Not yet pushed → an icon-only button (upload icon, no destination configured hides it entirely) that pushes just that one product.
- Already pushed → an **Update quantity** button that opens the modal below.

Each row's push button is wired to its own independent request — clicking one row's button never shows a loading spinner on any other row.

### Modal: Update quantity

Opens per product, listing **every variant** on its own line — this exists specifically so multi-variant products don't need one giant stacked control per variant crammed into the table row.

Per variant:
- `{Variant title} — SKU: {sku}`
- A quantity field, defaulting to that variant's current available count, capped at that count (client-side, and re-checked server-side against the *live* number at save time — you can never publish more than you actually have, even if the number changes between opening the modal and clicking save).
- `/ {N} available` for reference.

**Save changes** validates every line before submitting anything — if any single variant's number is invalid or over its cap, nothing is sent and you're told which one. While saving, the modal stays open with a spinner and "Publishing quantities to the destination store…", and all fields are disabled. It only closes automatically once the save is confirmed successful; on a failure (partial or total), it stays open with the specific error so you can see what went wrong and retry.

**Cancel** discards and closes without submitting.

---

## Common flows

### First-time setup
1. **Settings** → fill in the destination's domain, Client ID, and Client Secret → **Connect destination store**.
2. (Optional but recommended) Upload a logo and fill in brand details → **Save brand profile**.
3. **Products** → the catalog now shows a real destination name in the section heading and every row's push control is live.

### Push a single product
**Products** → click the upload-icon button on that row. Toast confirms "Pushed {title}" or reports the specific failure.

### Push several products at once
**Products** → check the rows you want → **Push to destination store** (top-left). Only the unpushed ones in your selection are actually sent; already-pushed ones in the same selection are left alone.

### Adjust quantity for one variant
**Products** → **Update quantity** on that row → edit the number for the variant you want to change → **Save changes**.

### Quickly resync several products to full stock
**Products** → check the already-pushed rows you want → use the bulk bar's **Update quantity for N**. This always mirrors full available stock — it's not for partial amounts.

### Find something in a large catalog
**Products** → type into the search field, and/or toggle **Active only** / **Pushed only**.

---

## Error messages you might see, and what they mean

| Message | Meaning |
|---|---|
| "Enter a valid *.myshopify.com domain." | The destination domain field didn't parse to a real shop domain |
| "You can't connect a store to itself." | Destination domain matched the vendor's own store |
| "Destination store rejected the credentials: …" | Client ID/Secret are wrong, or missing the required scopes on the destination's custom app |
| "Destination store has no inventory location." | The destination store has no location Shopify can stock inventory at |
| "{Variant} can't exceed available quantity (N)" | You tried to publish more units than the source variant currently has |
| "N variant(s) updated, M failed: …" | A batch quantity update partially succeeded — the trailing detail is Shopify's own error text for the failed ones |
| "Please choose an image file" / "Please upload an image file." | The logo dropzone only accepts image files |
