const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function TrimmedHistoryNotice({ trimmedAt }: { trimmedAt: string }) {
  return (
    <div className="messages-timeline-row-frame">
      <p className="chat-content-lane pt-1 text-center text-muted-foreground text-xs sm:pt-2">
        Tool output and agent work in this thread were removed on{" "}
        {DATE_FORMAT.format(new Date(trimmedAt))} to save space. Messages were kept.
      </p>
    </div>
  );
}
