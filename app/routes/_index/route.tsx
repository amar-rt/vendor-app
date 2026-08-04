import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <span className={styles.eyebrow}>Vendor Sync</span>
        <h1 className={styles.heading}>
          Publish your catalog straight into your retail partners' stores
        </h1>
        <p className={styles.text}>
          Push products — images, price, and brand identity included — from
          your own store into a destination store's catalog, then keep
          inventory in sync down to the variant, all without either store
          re-entering a thing.
        </p>

        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="my-shop-domain.myshopify.com"
              />
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}

        <ul className={styles.list}>
          <li>
            <span className={styles.bullet} aria-hidden="true">
              ↗
            </span>
            <div>
              <strong>One-click catalog push.</strong> Select products from
              your own store and publish them to your retail partner's
              store — photos, pricing, and variants included, with no manual
              re-entry on either side.
            </div>
          </li>
          <li>
            <span className={styles.bullet} aria-hidden="true">
              ⟲
            </span>
            <div>
              <strong>Precise inventory control.</strong> Decide exactly how
              much stock to publish per variant, and re-sync whenever your
              numbers change — every update is checked against what you
              actually have on hand.
            </div>
          </li>
          <li>
            <span className={styles.bullet} aria-hidden="true">
              ✦
            </span>
            <div>
              <strong>Built-in brand identity.</strong> Your logo,
              description, and accent color travel with every product you
              publish, so your brand stays visible wherever it's sold.
            </div>
          </li>
        </ul>
      </div>
    </div>
  );
}
