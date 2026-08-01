import { eq } from "drizzle-orm";
import { env } from "cloudflare:workers";
import { getDb } from "../db";
import { aiDisclosureConfirmations } from "../db/schema";
import type { CurrentUser } from "./current-user";
import { getOrCreateBillingUser } from "./billing-store";

let disclosureSchemaReady = false;

type D1SchemaStatement = {
  bind?: (...values: unknown[]) => D1SchemaStatement;
};

type D1SchemaDatabase = {
  prepare: (query: string) => D1SchemaStatement;
  batch: (statements: D1SchemaStatement[]) => Promise<unknown>;
};

async function ensureDisclosureSchema() {
  if (disclosureSchemaReady) return;
  const database = env.DB as unknown as D1SchemaDatabase | undefined;
  if (!database?.prepare || !database?.batch) {
    throw new Error("AI disclosure database binding is unavailable.");
  }
  await database.batch([
    database.prepare(`
      CREATE TABLE IF NOT EXISTS ai_disclosure_confirmations (
        id text PRIMARY KEY NOT NULL,
        confirmation_id text NOT NULL,
        user_id text,
        session_hash text NOT NULL,
        action text NOT NULL,
        disclosure_method text NOT NULL,
        terms_version text NOT NULL,
        created_at integer NOT NULL
      )
    `),
    database.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS ai_disclosure_confirmation_id_unique
      ON ai_disclosure_confirmations (confirmation_id)
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS ai_disclosure_user_id_idx
      ON ai_disclosure_confirmations (user_id)
    `),
    database.prepare(`
      CREATE INDEX IF NOT EXISTS ai_disclosure_created_at_idx
      ON ai_disclosure_confirmations (created_at)
    `),
  ]);
  disclosureSchemaReady = true;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function recordNarrationDisclosureConfirmation(input: {
  confirmationId: string;
  clientSessionId: string;
  termsVersion: string;
  currentUser: CurrentUser | null;
}) {
  await ensureDisclosureSchema();
  const db = getDb();
  const existing = await db
    .select({
      id: aiDisclosureConfirmations.id,
      confirmationId: aiDisclosureConfirmations.confirmationId,
    })
    .from(aiDisclosureConfirmations)
    .where(
      eq(aiDisclosureConfirmations.confirmationId, input.confirmationId),
    )
    .limit(1);
  if (existing[0]) return existing[0];

  const user = input.currentUser
    ? await getOrCreateBillingUser(input.currentUser)
    : null;
  const confirmation = {
    id: crypto.randomUUID(),
    confirmationId: input.confirmationId,
    userId: user?.id ?? null,
    sessionHash: await sha256(input.clientSessionId),
    action: "export" as const,
    disclosureMethod: "post_caption" as const,
    termsVersion: input.termsVersion,
    createdAt: Math.floor(Date.now() / 1_000),
  };
  await db.insert(aiDisclosureConfirmations).values(confirmation);
  return confirmation;
}
