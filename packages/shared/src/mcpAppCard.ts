import * as Predicate from "effect/Predicate";

import { MCP_APP_OUTPUT_KEY } from "./mcpApp.ts";

export const MCP_APP_CARD_OUTPUT_KEY = `${MCP_APP_OUTPUT_KEY}Card` as const;
const MCP_APP_CARD_META_KEY = "rails/app";
export const MCP_APP_CARD_HEIGHT = 398;
export const MCP_APP_CARD_HOST_TOKEN = "RailsDesktop/";
export const MCP_APP_CARD_PATH = "/card/app";

const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 256;

export interface McpAppCardReference {
  readonly card: string;
  readonly link?: string;
  readonly server?: string;
  readonly lane?: string;
}

function cardUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH || !URL.canParse(value)) {
    return undefined;
  }
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1")
    ? value
    : undefined;
}

function boundedName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_NAME_LENGTH
    ? value
    : undefined;
}

function readMcpAppCard(value: unknown): McpAppCardReference | undefined {
  if (!Predicate.isObject(value)) return undefined;
  const card = cardUrl(value.card);
  if (card === undefined) return undefined;
  const link = cardUrl(value.link);
  const server = boundedName(value.server);
  const lane = boundedName(value.lane);
  return {
    card,
    ...(link === undefined ? {} : { link }),
    ...(server === undefined ? {} : { server }),
    ...(lane === undefined ? {} : { lane }),
  };
}

export function mcpAppCardFromMeta(meta: unknown): McpAppCardReference | undefined {
  return Predicate.isObject(meta) ? readMcpAppCard(meta[MCP_APP_CARD_META_KEY]) : undefined;
}

export function mcpAppCardFromOutput(output: unknown): McpAppCardReference | undefined {
  return Predicate.isObject(output) ? readMcpAppCard(output[MCP_APP_CARD_OUTPUT_KEY]) : undefined;
}

export function mcpAppCardFromToolItem(item: {
  readonly type: string;
  readonly output?: unknown;
}): McpAppCardReference | undefined {
  return item.type === "dynamic_tool" ? mcpAppCardFromOutput(item.output) : undefined;
}

export function mcpAppCardsEqual(left: McpAppCardReference, right: McpAppCardReference): boolean {
  return (
    left.card === right.card &&
    left.link === right.link &&
    left.server === right.server &&
    left.lane === right.lane
  );
}
