import {
  getPersonalEditPreferences,
  PersonalEditPreferencesValidationError,
  resetPersonalEditPreferences,
  savePersonalEditPreferences,
} from "../../../lib/personal-edit-preferences-store";
import { PERSONAL_EDIT_PREFERENCE_LIMITS } from "../../../lib/personal-edit-preferences";
import {
  authenticationRequired,
  getCurrentUser,
} from "../../../lib/current-user";
import {
  parseJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "../../../lib/request-safety";

const PRIVATE_NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store",
};

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const currentUser = await getCurrentUser(request);
  if (!currentUser) return authenticationRequired();

  try {
    return preferencesResponse(await getPersonalEditPreferences(currentUser));
  } catch (error) {
    console.error("personal edit preferences read failed", error);
    return errorResponse(
      "設定を読み込めませんでした。もう一度お試しください。",
      "preferences_read_failed",
      500,
    );
  }
}

export async function PUT(request: Request) {
  const currentUser = await getCurrentUser(request);
  if (!currentUser) return authenticationRequired();

  let payload: unknown;
  try {
    payload = await parseJsonBodyWithLimit<unknown>(
      request,
      PERSONAL_EDIT_PREFERENCE_LIMITS.requestBytes,
    );
  } catch (error) {
    return error instanceof RequestBodyTooLargeError
      ? errorResponse(
          "設定の送信サイズが大きすぎます。辞書の件数を減らしてください。",
          "preferences_request_too_large",
          413,
        )
      : errorResponse(
          "設定内容を確認できませんでした。",
          "invalid_preferences_payload",
          400,
        );
  }

  try {
    const update = validateUpdatePayload(payload);
    return preferencesResponse(
      await savePersonalEditPreferences(currentUser, update),
    );
  } catch (error) {
    if (error instanceof PersonalEditPreferencesValidationError) {
      return errorResponse(
        "保存する設定を確認してください。",
        error.code,
        400,
      );
    }
    console.error("personal edit preferences write failed", error);
    return errorResponse(
      "設定を保存できませんでした。もう一度お試しください。",
      "preferences_write_failed",
      500,
    );
  }
}

export async function DELETE(request: Request) {
  const currentUser = await getCurrentUser(request);
  if (!currentUser) return authenticationRequired();

  try {
    return preferencesResponse(await resetPersonalEditPreferences(currentUser));
  } catch (error) {
    console.error("personal edit preferences reset failed", error);
    return errorResponse(
      "保存済み設定を削除できませんでした。もう一度お試しください。",
      "preferences_reset_failed",
      500,
    );
  }
}

function validateUpdatePayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new PersonalEditPreferencesValidationError(
      "invalid_preferences_payload",
    );
  }
  const record = payload as Record<string, unknown>;
  const hasRecipe = Object.hasOwn(record, "recipe");
  const hasDictionary = Object.hasOwn(record, "dictionary");
  if (!hasRecipe && !hasDictionary) {
    throw new PersonalEditPreferencesValidationError("empty_update");
  }
  if (
    hasRecipe &&
    (!record.recipe ||
      typeof record.recipe !== "object" ||
      Array.isArray(record.recipe))
  ) {
    throw new PersonalEditPreferencesValidationError("invalid_recipe");
  }
  if (hasDictionary) {
    if (!Array.isArray(record.dictionary)) {
      throw new PersonalEditPreferencesValidationError("invalid_dictionary");
    }
    if (
      record.dictionary.length >
      PERSONAL_EDIT_PREFERENCE_LIMITS.dictionaryEntries
    ) {
      throw new PersonalEditPreferencesValidationError(
        "dictionary_entry_limit_exceeded",
      );
    }
    const invalidEntry = record.dictionary.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof (entry as Record<string, unknown>).display !== "string" ||
        typeof (entry as Record<string, unknown>).reading !== "string",
    );
    if (invalidEntry) {
      throw new PersonalEditPreferencesValidationError(
        "invalid_dictionary_entry",
      );
    }
  }
  return {
    ...(hasRecipe ? { recipe: record.recipe } : {}),
    ...(hasDictionary ? { dictionary: record.dictionary } : {}),
  };
}

function preferencesResponse(preferences: {
  accountStorageId: string;
  recipe: unknown;
  dictionary: unknown;
}) {
  return Response.json(
    {
      ...preferences,
      limits: PERSONAL_EDIT_PREFERENCE_LIMITS,
    },
    { headers: PRIVATE_NO_STORE_HEADERS },
  );
}

function errorResponse(error: string, code: string, status: number) {
  return Response.json(
    { error, code },
    { status, headers: PRIVATE_NO_STORE_HEADERS },
  );
}
