import { inEmbedPage } from "../../embed/embedProtocol";
import { Button } from "../ui/button";

export function CodexDesktopHandoff({ url }: { readonly url: string | null }) {
  if (url === null || inEmbedPage()) return null;
  return (
    <details>
      <summary className="cursor-pointer">Other ways to connect</summary>
      <Button className="mt-2" size="sm" variant="outline" render={<a href={url} />}>
        Use T3 desktop for automatic return
      </Button>
    </details>
  );
}
