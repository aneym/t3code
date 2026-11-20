import { prefetchEmbedDescriptor } from "./embed/embedEarlyDescriptor";
import { listenForEarlyEmbedTheme } from "./embed/embedEarlyTheme";
import { clearBootRetry, recoverFromBootFailure } from "./lib/bootRetry";

listenForEarlyEmbedTheme();
prefetchEmbedDescriptor();

// Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
void import("./main").then(({ startup }) => startup).then(clearBootRetry, recoverFromBootFailure);
