/*
  Warnings:

  - You are about to drop the `ChannelState` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SignedState` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE "ChannelState";

-- DropTable
DROP TABLE "SignedState";

-- DropEnum
DROP TYPE "ChannelStateStatus";

-- DropEnum
DROP TYPE "SignedStateIntent";
