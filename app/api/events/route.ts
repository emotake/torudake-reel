import {
  isClientProductEvent,
  isPlainRecord,
  isSameOriginProductEvent,
  recordClientProductEvent,
  sanitizeProductProperties,
} from "../../../lib/product-analytics";
import {
  parseJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "../../../lib/request-safety";

const MAX_EVENT_BODY_BYTES = 4 * 1024;

export async function POST(request: Request) {
  if (!isSameOriginProductEvent(request)) {
    return Response.json({ error: "invalid_origin" }, { status: 403 });
  }
  let rawPayload: unknown;
  try {
    rawPayload = await parseJsonBodyWithLimit<unknown>(
      request,
      MAX_EVENT_BODY_BYTES,
    );
  } catch (error) {
    return Response.json(
      { error: error instanceof RequestBodyTooLargeError ? "too_large" : "invalid_json" },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  if (!isPlainRecord(rawPayload)) {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const payload = rawPayload;
  if (!isClientProductEvent(payload.event)) {
    return Response.json({ error: "invalid_event" }, { status: 400 });
  }
  const properties = sanitizeProductProperties(payload.properties);
  if (!properties) {
    return Response.json({ error: "invalid_properties" }, { status: 400 });
  }
  try {
    const accepted = await recordClientProductEvent(
      request,
      payload.event,
      properties,
    );
    return Response.json(
      { ok: accepted },
      { status: accepted ? 202 : 429, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.warn("browser product event was not recorded", error);
    return Response.json({ ok: false }, { status: 503 });
  }
}
