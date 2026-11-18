-- CreateTable
CREATE TABLE "company_integrations" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "api_key_hash" TEXT NOT NULL,
    "api_key_prefix" TEXT NOT NULL,
    "hmac_secret" TEXT,
    "require_signature" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_sync_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "company_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracked_orders" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "external_order_id" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'brango',
    "membership_id" UUID,
    "customer_id" UUID,
    "status" TEXT NOT NULL,
    "origin_code" TEXT NOT NULL,
    "link_status" TEXT NOT NULL DEFAULT 'pending_link',
    "link_reason" TEXT,
    "reported_commercial_phone" TEXT NOT NULL,
    "reported_commercial_name" TEXT,
    "reported_customer_name" TEXT NOT NULL,
    "reported_customer_ruc" TEXT,
    "customer_address" TEXT,
    "district" TEXT,
    "carrier_name" TEXT,
    "carrier_phone" TEXT,
    "packages_count" INTEGER,
    "total_amount" TEXT,
    "delivery_date_label" TEXT,
    "notes" TEXT,
    "evidence" JSONB,
    "last_event_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tracked_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tracked_order_events" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "external_event_id" TEXT,
    "status" TEXT NOT NULL,
    "origin_code" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tracked_order_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_integrations_api_key_hash_key" ON "company_integrations"("api_key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "company_integrations_company_id_provider_key" ON "company_integrations"("company_id", "provider");

-- CreateIndex
CREATE INDEX "tracked_orders_company_id_membership_id_last_event_at_idx" ON "tracked_orders"("company_id", "membership_id", "last_event_at" DESC);

-- CreateIndex
CREATE INDEX "tracked_orders_company_id_status_last_event_at_idx" ON "tracked_orders"("company_id", "status", "last_event_at" DESC);

-- CreateIndex
CREATE INDEX "tracked_orders_company_id_link_status_last_event_at_idx" ON "tracked_orders"("company_id", "link_status", "last_event_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "tracked_orders_company_id_external_order_id_key" ON "tracked_orders"("company_id", "external_order_id");

-- CreateIndex
CREATE INDEX "tracked_order_events_order_id_occurred_at_idx" ON "tracked_order_events"("order_id", "occurred_at" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "tracked_order_events_company_id_order_id_external_event_id_key" ON "tracked_order_events"("company_id", "order_id", "external_event_id");

-- AddForeignKey
ALTER TABLE "company_integrations" ADD CONSTRAINT "company_integrations_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tracked_orders" ADD CONSTRAINT "tracked_orders_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tracked_orders" ADD CONSTRAINT "tracked_orders_company_id_membership_id_fkey" FOREIGN KEY ("company_id", "membership_id") REFERENCES "memberships"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tracked_orders" ADD CONSTRAINT "tracked_orders_company_id_customer_id_fkey" FOREIGN KEY ("company_id", "customer_id") REFERENCES "customers"("company_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "tracked_order_events" ADD CONSTRAINT "tracked_order_events_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "tracked_orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

