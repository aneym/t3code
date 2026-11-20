import { chatSessionOwnsThreads, subscribeChatSession } from "@t3tools/client-runtime/chat-session";
import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { useChatSession } from "../chatSessionMode";
import { useEnvironmentScope } from "../state/session";

export function useSpeechAccess(environmentId: EnvironmentId | null) {
  const chat = useChatSession();
  const owner = useSyncExternalStore(subscribeChatSession, chatSessionOwnsThreads, () => false);
  const operate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const manage = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  return { dictate: chat ? owner : operate, cleanUp: operate && !chat, manage };
}
