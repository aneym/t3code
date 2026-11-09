import { compressImageForStash, readFileAsDataUrl } from "../lib/imageCompression";
import { inEmbedPage } from "./embedProtocol";

type PersistableImage = { dataUrl: string; mimeType: string; sizeBytes: number };

export async function persistableImage(image: {
  file: File;
  mimeType: string;
  sizeBytes: number;
}): Promise<PersistableImage> {
  if (!inEmbedPage()) {
    const dataUrl = await readFileAsDataUrl(image.file);
    return { dataUrl, mimeType: image.mimeType, sizeBytes: image.sizeBytes };
  }
  const result = await compressImageForStash(image.file);
  if (!result.ok) throw new Error(result.reason);
  return result.image;
}
