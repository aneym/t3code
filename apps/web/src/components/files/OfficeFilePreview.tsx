import type { OfficePreviewKind } from "@t3tools/shared/filePreview";
import { lazy, Suspense, use, useReducer, type ReactNode } from "react";

import { clientExtrasReady, retryClientExtras } from "./clientExtras";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";

const OfficeViewer = lazy(() => import("./OfficeViewer"));

export function OfficeFilePreview(props: {
  readonly src: string;
  readonly name: string;
  readonly kind: OfficePreviewKind;
  readonly sizeBytes?: number;
}) {
  const [, retry] = useReducer((attempt: number) => attempt + 1, 0);
  return (
    <Suspense fallback={<FileSurfaceLoading />}>
      <ClientExtrasGate
        onRetry={() => {
          retryClientExtras();
          retry();
        }}
      >
        <OfficeViewer key={JSON.stringify([props.src, props.kind, props.sizeBytes])} {...props} />
      </ClientExtrasGate>
    </Suspense>
  );
}

function ClientExtrasGate(props: { readonly onRetry: () => void; readonly children: ReactNode }) {
  if (use(clientExtrasReady()) === "ready") return props.children;
  return (
    <FileSurfaceFailure
      message="The Office viewer is unavailable: its one-time download of fonts and engines failed. If this machine can't reach GitHub, set T3CODE_RELEASE_BASE_URL to a release mirror and restart T3."
      onRetry={props.onRetry}
    />
  );
}
