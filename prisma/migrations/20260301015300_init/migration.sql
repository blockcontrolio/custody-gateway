-- CreateTable
CREATE TABLE "YellowSession" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "partnerId" TEXT,
    "userId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "YellowSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignedState" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "sessionId" TEXT,
    "stateVersion" INTEGER NOT NULL,
    "intent" TEXT NOT NULL,
    "stateData" JSONB NOT NULL,
    "allocations" JSONB NOT NULL,
    "signatures" JSONB NOT NULL,
    "rawMessage" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignedState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelState" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "participants" JSONB NOT NULL,
    "chainId" INTEGER,
    "token" TEXT,
    "balance" JSONB,
    "lastUpdate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "YellowSession_sessionId_key" ON "YellowSession"("sessionId");

-- CreateIndex
CREATE INDEX "SignedState_channelId_idx" ON "SignedState"("channelId");

-- CreateIndex
CREATE INDEX "SignedState_sessionId_idx" ON "SignedState"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelState_channelId_key" ON "ChannelState"("channelId");
