-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Brand" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoUrl" TEXT,
    "description" TEXT,
    "accentColor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Brand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DestinationStore" (
    "id" TEXT NOT NULL,
    "vendorShop" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DestinationStore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductLink" (
    "id" TEXT NOT NULL,
    "destinationStoreId" TEXT NOT NULL,
    "vendorShop" TEXT NOT NULL,
    "destinationShop" TEXT NOT NULL,
    "sourceProductId" TEXT NOT NULL,
    "destinationProductId" TEXT NOT NULL,
    "destinationLocationId" TEXT NOT NULL,
    "brand" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariantLink" (
    "id" TEXT NOT NULL,
    "productLinkId" TEXT NOT NULL,
    "sourceVariantId" TEXT NOT NULL,
    "sourceInventoryItemId" TEXT NOT NULL,
    "destinationVariantId" TEXT NOT NULL,
    "destinationInventoryItemId" TEXT NOT NULL,
    "sku" TEXT,

    CONSTRAINT "VariantLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Brand_shop_idx" ON "Brand"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_shop_name_key" ON "Brand"("shop", "name");

-- CreateIndex
CREATE UNIQUE INDEX "DestinationStore_vendorShop_key" ON "DestinationStore"("vendorShop");

-- CreateIndex
CREATE INDEX "ProductLink_destinationStoreId_idx" ON "ProductLink"("destinationStoreId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductLink_vendorShop_destinationShop_sourceProductId_key" ON "ProductLink"("vendorShop", "destinationShop", "sourceProductId");

-- CreateIndex
CREATE UNIQUE INDEX "VariantLink_productLinkId_sourceVariantId_key" ON "VariantLink"("productLinkId", "sourceVariantId");

-- AddForeignKey
ALTER TABLE "ProductLink" ADD CONSTRAINT "ProductLink_destinationStoreId_fkey" FOREIGN KEY ("destinationStoreId") REFERENCES "DestinationStore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VariantLink" ADD CONSTRAINT "VariantLink_productLinkId_fkey" FOREIGN KEY ("productLinkId") REFERENCES "ProductLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

