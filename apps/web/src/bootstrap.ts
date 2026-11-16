import { clearBootRetry, recoverFromBootFailure } from "./lib/bootRetry";

// Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
void import("./main").then(({ startup }) => startup).then(clearBootRetry, recoverFromBootFailure);
