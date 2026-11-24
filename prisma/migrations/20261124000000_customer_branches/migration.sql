-- CreateTable: customer_branches
CREATE TABLE "customer_branches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "company_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT NOT NULL DEFAULT 'Principal',
    "address" TEXT NOT NULL,
    "district" TEXT,
    "zone" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "assignment_version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "customer_branches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_branches_company_id_id_key" ON "customer_branches"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_branches_unique_name" ON "customer_branches"("company_id", "customer_id", "name");

-- CreateIndex
CREATE INDEX "customer_branches_company_id_customer_id_idx" ON "customer_branches"("company_id", "customer_id");

-- AddForeignKey
ALTER TABLE "customer_branches" ADD CONSTRAINT "customer_branches_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "customer_branches" ADD CONSTRAINT "customer_branches_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "customers"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Migrate existing customers into default 'Principal' branches
INSERT INTO "customer_branches" (
    "id",
    "company_id",
    "customer_id",
    "created_at",
    "name",
    "address",
    "district",
    "zone",
    "latitude",
    "longitude",
    "is_default",
    "active",
    "assignment_version"
)
SELECT
    gen_random_uuid(),
    "company_id",
    "id",
    "created_at",
    'Principal',
    "address",
    "district",
    "zone",
    "latitude",
    "longitude",
    true,
    true,
    "assignment_version"
FROM "customers";

-- AlterTable: customer_assignments
ALTER TABLE "customer_assignments" ADD COLUMN "branch_id" UUID;

UPDATE "customer_assignments" ca
SET "branch_id" = cb."id"
FROM "customer_branches" cb
WHERE cb."company_id" = ca."company_id"
  AND cb."customer_id" = ca."customer_id"
  AND cb."is_default" = true;

ALTER TABLE "customer_assignments" ALTER COLUMN "branch_id" SET NOT NULL;

ALTER TABLE "customer_assignments" DROP CONSTRAINT "customer_assignments_pkey";
ALTER TABLE "customer_assignments" ADD CONSTRAINT "customer_assignments_pkey" PRIMARY KEY ("company_id", "branch_id", "membership_id");

CREATE INDEX "customer_assignments_company_id_customer_id_idx" ON "customer_assignments"("company_id", "customer_id");

ALTER TABLE "customer_assignments" ADD CONSTRAINT "customer_assignments_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "customer_branches"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AlterTable: visits
ALTER TABLE "visits" ADD COLUMN "branch_id" UUID;

UPDATE "visits" v
SET "branch_id" = cb."id"
FROM "customer_branches" cb
WHERE cb."company_id" = v."company_id"
  AND cb."customer_id" = v."customer_id"
  AND cb."is_default" = true;

ALTER TABLE "visits" ALTER COLUMN "branch_id" SET NOT NULL;

ALTER TABLE "visits" ADD CONSTRAINT "visits_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "customer_branches"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AlterTable: tracked_orders
ALTER TABLE "tracked_orders" ADD COLUMN "branch_id" UUID;

UPDATE "tracked_orders" o
SET "branch_id" = cb."id"
FROM "customer_branches" cb
WHERE cb."company_id" = o."company_id"
  AND cb."customer_id" = o."customer_id"
  AND cb."is_default" = true;

ALTER TABLE "tracked_orders" ADD CONSTRAINT "tracked_orders_company_id_branch_id_fkey" FOREIGN KEY ("company_id", "branch_id") REFERENCES "customer_branches"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Drop migrated location columns from customers
ALTER TABLE "customers" DROP COLUMN "address";
ALTER TABLE "customers" DROP COLUMN "district";
ALTER TABLE "customers" DROP COLUMN "zone";
ALTER TABLE "customers" DROP COLUMN "latitude";
ALTER TABLE "customers" DROP COLUMN "longitude";
