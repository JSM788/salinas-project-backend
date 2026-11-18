-- AlterTable
ALTER TABLE "workdays" ADD COLUMN "start_latitude" DOUBLE PRECISION,
ADD COLUMN "start_longitude" DOUBLE PRECISION,
ADD COLUMN "end_latitude" DOUBLE PRECISION,
ADD COLUMN "end_longitude" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "visits" ADD COLUMN "check_in_latitude" DOUBLE PRECISION,
ADD COLUMN "check_in_longitude" DOUBLE PRECISION;

