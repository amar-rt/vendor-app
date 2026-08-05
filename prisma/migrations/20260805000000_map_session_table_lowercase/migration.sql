-- @shopify/shopify-app-session-storage-prisma expects the session table to
-- be named lowercase "session"; Prisma Migrate creates it as "Session"
-- (case-preserved) by default without an explicit @@map.
ALTER TABLE "Session" RENAME TO "session";
