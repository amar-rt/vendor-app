-- Never read anywhere after being written, and the stored value was
-- actually a variant ID (not a real inventory item ID) despite the name.
ALTER TABLE "VariantLink" DROP COLUMN "sourceInventoryItemId";
