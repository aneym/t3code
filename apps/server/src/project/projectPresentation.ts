import type { Project } from "@t3tools/contracts";
import type { ProjectRow } from "../orchestration-v2/ProjectStore.ts";
import type { ProjectEnrichment } from "./ProjectEnrichmentService.ts";

export const toProject = (row: ProjectRow, enrichment: ProjectEnrichment | null): Project => ({
  id: row.projectId,
  title: row.title,
  workspaceRoot: row.workspaceRoot,
  repositoryIdentity: enrichment?.repositoryIdentity ?? null,
  faviconPath: row.faviconPath ?? enrichment?.faviconPath ?? null,
  defaultModelSelection: row.defaultModelSelection,
  defaultThreadEnvMode: row.defaultThreadEnvMode,
  autoPull: row.autoPull,
  pinOrder: row.pinOrder ?? null,
  projectIcon: row.projectIcon,
  scripts: row.scripts,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  deletedAt: row.deletedAt,
});
