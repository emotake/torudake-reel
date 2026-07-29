interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface D1Database {}

interface R2Bucket {}

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
    MEDIA: R2Bucket;
    OPENAI_API_KEY?: string;
    STRIPE_SECRET_KEY?: string;
    STRIPE_WEBHOOK_SECRET?: string;
    STRIPE_PRICE_LIGHT_MONTHLY?: string;
    STRIPE_PRICE_ONE_TIME?: string;
    [binding: string]: unknown;
  };
}
