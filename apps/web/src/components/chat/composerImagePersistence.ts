import type {
  ComposerImageAttachment,
  PersistedComposerImageAttachment,
} from "../../composerDraftStore";
import { persistableImage } from "../../embed/embedImagePersistence";

export async function serializeComposerImages(
  images: ReadonlyArray<ComposerImageAttachment>,
  persistedAttachments: ReadonlyArray<PersistedComposerImageAttachment>,
): Promise<PersistedComposerImageAttachment[]> {
  const existingPersistedById = new Map(
    persistedAttachments.map((attachment) => [attachment.id, attachment]),
  );
  const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
  await Promise.all(
    images.map(async (image) => {
      try {
        const persisted = existingPersistedById.get(image.id) ?? (await persistableImage(image));
        stagedAttachmentById.set(image.id, {
          id: image.id,
          name: image.name,
          mimeType: persisted.mimeType,
          sizeBytes: persisted.sizeBytes,
          dataUrl: persisted.dataUrl,
          ...(image.source ? { source: image.source } : {}),
        });
      } catch {
        const existingPersisted = existingPersistedById.get(image.id);
        if (existingPersisted) {
          stagedAttachmentById.set(image.id, existingPersisted);
        }
      }
    }),
  );
  return Array.from(stagedAttachmentById.values());
}
