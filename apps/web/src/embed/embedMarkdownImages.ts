import type { Element, ElementContent, Root } from "hast";

import { inRailsDoor } from "./embedProtocol";

const RAILS_ORIGIN = "https://one.rails.so";
const ID = "[A-Za-z0-9_-]";
const RAILS_FILE_PATHS = [
  new RegExp(`^/api/agents/${ID}{1,64}/(?:files|chat-images)/${ID}{22}$`),
  new RegExp(`^/api/(?:chat|comment)-images/${ID}{1,64}/${ID}{22}$`),
  new RegExp(`^/x/${ID}{1,64}/(?:image|og\\.png|(?:asset|files)/${ID}{1,64})$`),
];
const WEB_SOURCE = /^(?:https?:|\/\/)/i;

function isRailsFileImage(raw: string): boolean {
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    (url.origin === RAILS_ORIGIN || url.origin === window.location.origin) &&
    RAILS_FILE_PATHS.some((path) => path.test(url.pathname))
  );
}

function imageAsLink(image: Element, inLink: boolean): ElementContent | null {
  const { src, alt } = image.properties;
  const label = typeof alt === "string" ? alt.trim() : "";
  if (typeof src !== "string" || !WEB_SOURCE.test(src)) return null;
  if (label && isRailsFileImage(src)) return null;
  const text: ElementContent = { type: "text", value: label || src };
  if (inLink) return text;
  return { type: "element", tagName: "a", properties: { href: src }, children: [text] };
}

function relinkImages(node: Root | Element, inLink: boolean): void {
  node.children.forEach((child, index) => {
    if (child.type !== "element") return;
    const link = child.tagName === "img" ? imageAsLink(child, inLink) : null;
    if (link) node.children[index] = link;
    else relinkImages(child, inLink || child.tagName === "a");
  });
}

export function rehypeEmbedImageLinks() {
  return (tree: Root) => {
    if (inRailsDoor()) relinkImages(tree, false);
  };
}
