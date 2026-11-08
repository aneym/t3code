import { readEmbedBearerToken } from "../../embed/embedSignIn";
import { readDesktopPrimaryBearerToken } from "./desktopAuth";

export function readPrimaryBearerToken(): Promise<string | null> {
  const embedBearerToken = readEmbedBearerToken();
  return embedBearerToken === null
    ? readDesktopPrimaryBearerToken()
    : Promise.resolve(embedBearerToken);
}
