-- AlterEnum
ALTER TYPE "NotificationStatus" ADD VALUE 'NO_TRANSPORT';

-- DropForeignKey
ALTER TABLE "InterlockOverride" DROP CONSTRAINT "InterlockOverride_approvedById_fkey";

-- DropForeignKey
ALTER TABLE "InterlockThreshold" DROP CONSTRAINT "InterlockThreshold_confirmedById_fkey";

-- DropIndex
DROP INDEX "InterlockOverride_id_key";

-- AddForeignKey
ALTER TABLE "InterlockOverride" ADD CONSTRAINT "InterlockOverride_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InterlockThreshold" ADD CONSTRAINT "InterlockThreshold_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
