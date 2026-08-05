-- One brand per vendor shop now (was: many brands per shop, auto-matched to
-- products by vendor/product-type name). Keep the oldest brand per shop and
-- drop any extras before enforcing the new constraint.
DELETE FROM "Brand" a USING "Brand" b
WHERE a."shop" = b."shop"
  AND (a."createdAt" > b."createdAt"
       OR (a."createdAt" = b."createdAt" AND a."id" > b."id"));

DROP INDEX IF EXISTS "Brand_shop_name_key";
DROP INDEX IF EXISTS "Brand_shop_idx";

ALTER TABLE "Brand" ADD CONSTRAINT "Brand_shop_key" UNIQUE ("shop");
