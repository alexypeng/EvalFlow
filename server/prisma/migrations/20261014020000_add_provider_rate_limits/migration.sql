-- CreateTable
CREATE TABLE "provider_rate_limits" (
    "provider" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 2,
    "refill_per_second" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "tokens" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "refilled_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_rate_limits_pkey" PRIMARY KEY ("provider"),
    CONSTRAINT "provider_rate_limits_provider_check" CHECK ("provider" IN ('mock', 'gemini')),
    CONSTRAINT "provider_rate_limits_capacity_check" CHECK ("capacity" BETWEEN 1 AND 1000),
    CONSTRAINT "provider_rate_limits_refill_check" CHECK ("refill_per_second" BETWEEN 0.001 AND 1000),
    CONSTRAINT "provider_rate_limits_tokens_check" CHECK ("tokens" >= 0 AND "tokens" <= "capacity")
);
