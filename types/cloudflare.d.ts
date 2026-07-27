interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface D1Database {}

interface R2Bucket {}

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
    MEDIA: R2Bucket;
    [binding: string]: unknown;
  };
}
