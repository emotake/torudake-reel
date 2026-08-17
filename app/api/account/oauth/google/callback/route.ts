import {
  oidcCallbackFinalizationPage,
  oidcAuthErrorResponse,
} from "../../../../../../lib/oidc-auth";

export async function GET(request: Request) {
  try {
    return oidcCallbackFinalizationPage(request, "google");
  } catch (error) {
    return oidcAuthErrorResponse(error);
  }
}
