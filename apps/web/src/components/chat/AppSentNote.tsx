import { inEmbedPage } from "../../embed/embedProtocol";

export function AppSentNote() {
  return (
    <p className="me-1 text-2xs text-muted-foreground/70">
      {inEmbedPage() ? "Sent automatically" : "Sent by T3 Code"}
    </p>
  );
}
