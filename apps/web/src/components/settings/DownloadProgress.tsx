export function DownloadProgress({
  label,
  downloadedBytes,
  totalBytes,
}: {
  readonly label: string;
  readonly downloadedBytes: number;
  readonly totalBytes: number;
}) {
  return (
    <progress
      aria-label={label}
      // Forced-colors mode repaints the track and fill as Canvas, and
      // appearance:auto cannot bring the native widget back: the
      // preflight border reset marks every <progress> as author-styled,
      // so Chromium keeps its fallback paint. Use system colors instead.
      className="block h-1 w-full appearance-none overflow-hidden rounded-full bg-muted forced-colors:border [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-primary forced-colors:[&::-moz-progress-bar]:bg-[Highlight] [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary forced-colors:[&::-webkit-progress-value]:bg-[Highlight]"
      value={downloadedBytes}
      max={totalBytes}
    />
  );
}
