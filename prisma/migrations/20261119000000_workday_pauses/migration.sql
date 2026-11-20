-- CreateTable
CREATE TABLE "pause_reasons" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pause_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workday_pauses" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "workday_id" UUID NOT NULL,
    "reason_id" UUID,
    "reason_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(6),
    "start_latitude" DOUBLE PRECISION,
    "start_longitude" DOUBLE PRECISION,
    "end_latitude" DOUBLE PRECISION,
    "end_longitude" DOUBLE PRECISION,

    CONSTRAINT "workday_pauses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pause_reasons_company_id_id_key" ON "pause_reasons"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "pause_reasons_company_id_name_key" ON "pause_reasons"("company_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "workday_pauses_company_id_id_key" ON "workday_pauses"("company_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "one_active_pause" ON "workday_pauses"("company_id", "membership_id") WHERE ("status" = 'active');

-- CreateIndex
CREATE INDEX "workday_pauses_company_id_workday_id_started_at_idx" ON "workday_pauses"("company_id", "workday_id", "started_at");

-- AddForeignKey
ALTER TABLE "pause_reasons" ADD CONSTRAINT "pause_reasons_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "workday_pauses" ADD CONSTRAINT "workday_pauses_company_id_membership_id_fkey" FOREIGN KEY ("company_id", "membership_id") REFERENCES "memberships"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "workday_pauses" ADD CONSTRAINT "workday_pauses_company_id_workday_id_fkey" FOREIGN KEY ("company_id", "workday_id") REFERENCES "workdays"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "workday_pauses" ADD CONSTRAINT "workday_pauses_company_id_reason_id_fkey" FOREIGN KEY ("company_id", "reason_id") REFERENCES "pause_reasons"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
