import type { GitCommandFailureReason } from "@t3tools/contracts";

// Stderr can echo credentials from argv/URLs; classify fixed patterns without exposing matched text.
const GIT_FAILURE_REASON_PATTERNS: ReadonlyArray<readonly [RegExp, GitCommandFailureReason]> = [
  [/would clobber existing tag/i, "tag_would_be_clobbered"],
  [/is already (?:used by worktree at|checked out at)/i, "branch_checked_out_in_worktree"],
  [/a branch named .+ already exists/i, "branch_already_exists"],
  // The same prefix also reports permission errors, which retrying cannot fix.
  [/could not lock config file .+: File exists/i, "config_locked"],
  [
    /(?:authentication failed|could not read Username|could not read Password|permission denied \([a-z-]+(?:,[a-z-]+)*\)|permission denied, please try again)/i,
    "authentication_failed",
  ],
  [/host key verification failed/i, "host_key_unverified"],
  [
    /(?:could not read from remote repository|does not appear to be a git repository|repository .+ not found)/i,
    "remote_unreachable",
  ],
  // Unquoted already-exists errors also describe ref/tag collisions; require quoted paths.
  [/fatal: '[^']+' already exists|destination path .+ already exists/i, "path_already_exists"],
  // Ambiguous revision/path and pathspec failures can name files, so omit them.
  // Anchor to a diagnostic line to avoid matching quoted paths in other errors.
  [
    /^fatal: (?:invalid reference: |not a valid object name|needed a single revision|bad revision |'.+' is not a commit and a branch '.+' cannot be created from it)/im,
    "ref_not_found",
  ],
  // `[remote rejected]` is only printed for a push. The remote's explanation
  // follows in parentheses; it is server text, so it is never quoted.
  [/^[ \t]*![ \t]+\[remote rejected\]/im, "push_rejected_by_remote"],
  // A fetch into a diverged local branch prints the same `[rejected]` line, but
  // only a push goes on to report "failed to push some refs".
  [
    /^[ \t]*![ \t]+\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)[\s\S]*^error: failed to push some refs/im,
    "push_rejected_non_fast_forward",
  ],
];

// Reasons the user can act on get a sentence in place of the generic detail.
const GIT_FAILURE_REASON_DETAILS: Partial<Record<GitCommandFailureReason, string>> = {
  push_rejected_by_remote:
    "The remote rejected the push. Push this branch from a terminal to see the server's message.",
  push_rejected_non_fast_forward:
    "The remote has commits this branch doesn't have. Pull or rebase, then push again.",
  config_locked:
    "Another Git process kept the repository's config locked. Wait for it to finish, then retry.",
};

export function gitFailureDetail(
  reason: GitCommandFailureReason | null,
  stderr: string,
  fallback?: string,
): string {
  const detail =
    fallback ??
    (reason === null ? undefined : GIT_FAILURE_REASON_DETAILS[reason]) ??
    "Git command exited with a non-zero status.";
  const excerpt = reason === null ? gitStderrExcerpt(stderr) : null;
  return excerpt === null ? detail : `${detail}: ${excerpt}`;
}

// Existing non-commit objects share the missing-ref fatal diagnostic; Git
// distinguishes them with a separate error line.
const GIT_NOT_A_COMMIT_PATTERN = /^error: .+(?:, not a commit|expected commit type)/im;

// Trust only Git's diagnostic prefixes: local hooks can write indistinguishable text.
// Exclude `remote:` too, since it prefixes remote hook output as well as server diagnostics.
const GIT_DIAGNOSTIC_LINE_PATTERN = /^(?:fatal|error):|^!\s|^\s+!\s/;
// SSH credential refusals are unprefixed; Git's later generic error would otherwise misclassify them as unreachable.
const SSH_TRANSPORT_REFUSAL_PATTERN =
  /Permission denied \((?:publickey|password|keyboard-interactive)|Permission denied, please try again|Host key verification failed/i;

export function classifyGitFailure(stderr: string): GitCommandFailureReason | null {
  const diagnostics = stderr
    .split(/\r?\n/)
    .filter(
      (line) =>
        GIT_DIAGNOSTIC_LINE_PATTERN.test(line) ||
        (!/^remote:/.test(line) && SSH_TRANSPORT_REFUSAL_PATTERN.test(line)),
    )
    .join("\n");
  if (diagnostics.length === 0) return null;
  if (isNonRepositoryGitStderr(diagnostics)) return "not_a_repository";
  for (const [pattern, reason] of GIT_FAILURE_REASON_PATTERNS) {
    if (!pattern.test(diagnostics)) continue;
    if (reason === "ref_not_found" && GIT_NOT_A_COMMIT_PATTERN.test(diagnostics)) continue;
    return reason;
  }
  return null;
}

export function isNonRepositoryGitStderr(stderr: string): boolean {
  return stderr.toLowerCase().includes("not a git repository");
}

const MAX_STDERR_EXCERPT_LENGTH = 300;
const GIT_PROGRESS_LINE_PATTERN = /^[\w ]+:\s+\d+% \(\d+\/\d+\)/;
const STDERR_CREDENTIAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@"],
  [/\b((?:proxy-)?authorization)\s*[:=].*$/gi, "$1: ***"],
  [/\b(bearer|basic)\s+\S+/gi, "$1 ***"],
  [/\b(token|password|passwd|secret|api[_-]?key)(\s*[:=]\s*|\s+)\S+/gi, "$1$2***"],
  [/\b(gh[opsur]_|github_pat_|glpat-|xox[abpr]-|sk-|AKIA)[\w-]+/g, "$1***"],
  [
    /([?&;][^=&\s]*(?:key|token|secret|password|auth|sig|signature|credential)[^=&\s]*=)[^&\s]+/gi,
    "$1***",
  ],
];

function gitStderrExcerpt(stderr: string): string | null {
  const lines = stderr
    .split(/\r?\n|\r/)
    .map((line) => line.replace(/\p{Cc}/gu, "").trim())
    .filter((line) => line.length > 0 && !GIT_PROGRESS_LINE_PATTERN.test(line));
  const diagnostics = lines.filter((line) => GIT_DIAGNOSTIC_LINE_PATTERN.test(line));
  const chosen = (diagnostics.length > 0 ? diagnostics : lines).slice(-3);
  if (chosen.length === 0) return null;
  let excerpt = chosen
    .map((line) =>
      STDERR_CREDENTIAL_PATTERNS.reduce(
        (text, [pattern, mask]) => text.replace(pattern, mask),
        line,
      ),
    )
    .join(" ");
  if (excerpt.length > MAX_STDERR_EXCERPT_LENGTH) {
    excerpt = `${excerpt.slice(0, MAX_STDERR_EXCERPT_LENGTH - 1)}…`;
  }
  return excerpt;
}
