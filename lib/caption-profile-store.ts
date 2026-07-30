import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { captionProfiles } from "../db/schema";
import {
  DEFAULT_CAPTION_PROFILE,
  normalizeCaptionProfile,
  type CaptionProfile,
} from "./caption-design";
import type { CurrentUser } from "./current-user";
import { getOrCreateBillingUser } from "./billing-store";

export async function getCaptionProfile(currentUser: CurrentUser) {
  const user = await getOrCreateBillingUser(currentUser);
  const rows = await getDb()
    .select()
    .from(captionProfiles)
    .where(eq(captionProfiles.userId, user.id))
    .limit(1);
  if (!rows[0]) return { ...DEFAULT_CAPTION_PROFILE };
  return normalizeCaptionProfile(rows[0]);
}

export async function saveCaptionProfile(
  currentUser: CurrentUser,
  profile: CaptionProfile,
) {
  const user = await getOrCreateBillingUser(currentUser);
  const normalized = normalizeCaptionProfile(profile);
  const updatedAt = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(captionProfiles)
    .values({
      userId: user.id,
      ...normalized,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: captionProfiles.userId,
      set: {
        ...normalized,
        updatedAt,
      },
    });
  return normalized;
}
