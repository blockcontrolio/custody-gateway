/*
  Warnings:

  - The `status` column on the `ChannelState` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `YellowSession` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `intent` on the `SignedState` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "YellowSessionStatus" AS ENUM ('active', 'closed');

-- CreateEnum
CREATE TYPE "SignedStateIntent" AS ENUM ('OPERATE', 'INITIALIZE', 'RESIZE', 'FINALIZE');

-- CreateEnum
CREATE TYPE "ChannelStateStatus" AS ENUM ('active', 'closed', 'challenged');

-- AlterTable
ALTER TABLE "ChannelState" DROP COLUMN "status",
ADD COLUMN     "status" "ChannelStateStatus" NOT NULL DEFAULT 'active';

-- AlterTable
ALTER TABLE "SignedState" DROP COLUMN "intent",
ADD COLUMN     "intent" "SignedStateIntent" NOT NULL;

-- AlterTable
ALTER TABLE "YellowSession" DROP COLUMN "status",
ADD COLUMN     "status" "YellowSessionStatus" NOT NULL DEFAULT 'active';
