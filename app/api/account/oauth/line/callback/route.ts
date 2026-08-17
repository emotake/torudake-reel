import {
  oidcCallbackFinalizationPage,
  oidcAuthErrorResponse,
} from "../../../../../../lib/oidc-auth";

export async function GET(request: Request) {
  try {
    return oidcCallbackFinalizationPage(request, "line");
  } catch (error) {
    return oidcAuthErrorResponse(error);
  }
}
