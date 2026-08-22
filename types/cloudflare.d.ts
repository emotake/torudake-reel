interface Fetcher {
  fetch(request: Request): Promise<Response>;
}
type D1Database = object;

type R2Bucket = object;

interface AnalyticsEngineDataset {
  writeDataPoint(event?: {
    indexes?: ((ArrayBuffer | string) | null)[];
    doubles?: number[];
    blobs?: ((ArrayBuffer | string) | null)[];
  }): void;
}

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
    MEDIA?: R2Bucket;
    OPENAI_API_KEY?: string;
    OPS_HEALTH_SECRET?: string;
    ACCOUNT_DELETION_OPERATIONS_SECRET?: string;
    NARRATION_SPEECH_MODE?: string;
    NARRATION_VOICE_PROFILE?: string;
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
    PASSKEY_AUTH_ENABLED?: string;
    OIDC_AUTH_ENABLED?: string;
    OIDC_CANONICAL_ORIGIN?: string;
    OIDC_AUTH_SECRET?: string;
    LINE_LOGIN_ENABLED?: string;
    LINE_LOGIN_CHANNEL_ID?: string;
    LINE_LOGIN_CHANNEL_SECRET?: string;
    GOOGLE_OIDC_ENABLED?: string;
    GOOGLE_OIDC_CLIENT_ID?: string;
    GOOGLE_OIDC_CLIENT_SECRET?: string;
    AUTH_OBSERVABILITY?: AnalyticsEngineDataset;
    [binding: string]: unknown;
  };
}
