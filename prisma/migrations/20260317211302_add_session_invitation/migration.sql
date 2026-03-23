-- CreateEnum
CREATE TYPE "SessionInvitationStatus" AS ENUM ('pending', 'accepted', 'rejected');

-- CreateTable
CREATE TABLE "SessionInvitation" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "initiatorAddr" TEXT NOT NULL,
    "inviteeAddr" TEXT NOT NULL,
    "amountInitiator" TEXT NOT NULL,
    "amountInvitee" TEXT NOT NULL,
    "status" "SessionInvitationStatus" NOT NULL DEFAULT 'pending',
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "SessionInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionInvitation_inviteeAddr_status_idx" ON "SessionInvitation"("inviteeAddr", "status");

-- CreateIndex
CREATE INDEX "SessionInvitation_initiatorAddr_idx" ON "SessionInvitation"("initiatorAddr");
