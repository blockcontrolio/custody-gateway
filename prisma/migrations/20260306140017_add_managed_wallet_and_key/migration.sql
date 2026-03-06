-- CreateTable
CREATE TABLE "ManagedWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagedWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManagedKey" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManagedKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManagedWallet_address_key" ON "ManagedWallet"("address");

-- CreateIndex
CREATE INDEX "ManagedWallet_userId_idx" ON "ManagedWallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ManagedKey_address_key" ON "ManagedKey"("address");
