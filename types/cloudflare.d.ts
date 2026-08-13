interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

type D1Database = object;

type R2Bucket = object;

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
    MEDIA?: R2Bucket;
    OPENAI_API_KEY?: string;
    OPS_HEALTH_SECRET?: string;
    ACCOUNT_DELETION_OPERATIONS_SECRET?: string;
    NARRATION_SPEECH_MODE?: string;
    TRUST_SITES_AUTH_HEADERS?: string;
    PUBLIC_ORIGIN?: string;
    STRIPE_SECRET_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
    STRIPE_PRICE_STARTER_MONTHLY?: string;
    STRIPE_PRICE_STANDARD_MONTHLY?: string;
    STRIPE_PRICE_LIGHT_MONTHLY?: string;
    STRIPE_PRICE_ONE_TIME?: string;
    OPERATOR_ENROLLMENT_CODE?: string;
    TRIAL_ISSUANCE_SECRET?: string;
    [binding: string]: unknown;
  };
}
