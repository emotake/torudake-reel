import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const videoTransfers = sqliteTable(
  "video_transfers",
  {
    id: text("id").primaryKey(),
    codeHash: text("code_hash").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    objectKey: text("object_key").notNull(),
    uploadId: text("upload_id").notNull(),
    status: text("status", {
      enum: ["uploading", "complete", "deleted"],
    })
      .notNull()
      .default("uploading"),
    ownerEmail: text("owner_email"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    completedAt: integer("completed_at"),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    uniqueIndex("video_transfers_code_hash_unique").on(table.codeHash),
    index("video_transfers_expires_at_idx").on(table.expiresAt),
    index("video_transfers_status_idx").on(table.status),
  ],
);
