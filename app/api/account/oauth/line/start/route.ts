import {
  beginOidcAuthorization,
  oidcAuthErrorResponse,
} from "../../../../../../lib/oidc-auth";

export async function GET(request: Request) {
  try {
    return await beginOidcAuthorization(request, "line");
  } catch (error) {
    return oidcAuthErrorResponse(error);
  }
}
