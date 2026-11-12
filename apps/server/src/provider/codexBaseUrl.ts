export const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

export const configuredCodexBaseUrl = (baseUrl: string | undefined): string | undefined =>
  baseUrl?.trim().replace(/\/+$/u, "") || undefined;

export const codexBaseUrl = (baseUrl: string | undefined): string =>
  configuredCodexBaseUrl(baseUrl) ?? OPENAI_API_BASE_URL;
