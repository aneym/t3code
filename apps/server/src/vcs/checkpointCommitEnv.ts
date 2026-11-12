import { appName } from "@t3tools/shared/appName";
import * as Effect from "effect/Effect";

const CHECKPOINT_EMAIL = "t3code@users.noreply.github.com";

export const checkpointCommitEnv = (indexFile: string) =>
  appName.pipe(
    Effect.map((name): NodeJS.ProcessEnv => ({
      ...process.env,
      GIT_INDEX_FILE: indexFile,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: CHECKPOINT_EMAIL,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: CHECKPOINT_EMAIL,
    })),
  );
