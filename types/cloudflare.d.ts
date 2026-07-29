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
    [binding: string]: unknown;
  };
}
