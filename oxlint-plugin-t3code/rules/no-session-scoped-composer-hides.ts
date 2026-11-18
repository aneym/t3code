import { defineRule } from "@oxlint/plugins";

const COMPOSER_CONTROL_FILE =
  /(?:^|\/)apps\/web\/src\/(?:embed\/embedComposer\.ts|components\/embed\/EmbedControls[^/]*|components\/chat\/(?:Composer[^/]*|CompactComposerControlsMenu[^/]*))$/u;
const SESSION_SCOPE_CALLS = new Set(["chatSessionActive", "useChatSession"]);

const MESSAGE =
  "Composer controls never hide by session scope: render the control from useChatThreadControls and show it disabled with a reason.";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hiding composer controls by chat session scope; seat threads show them disabled with a reason.",
    },
  },
  create(context) {
    const composerFile = COMPOSER_CONTROL_FILE.test(context.filename.replaceAll("\\", "/"));
    return {
      MemberExpression(node) {
        const property = node.property;
        const name =
          property.type === "Identifier"
            ? property.name
            : property.type === "Literal" && typeof property.value === "string"
              ? property.value
              : null;
        if (name !== "chatSession") return;
        const object = node.object;
        if (object.type !== "MemberExpression" || object.property.type !== "Identifier") return;
        if (object.property.name !== "dataset") return;
        context.report({ node, message: MESSAGE });
      },
      Literal(node) {
        if (typeof node.value !== "string" || !node.value.includes("data-chat-session")) return;
        context.report({ node, message: MESSAGE });
      },
      TemplateElement(node) {
        if (!(node.value.cooked ?? "").includes("data-chat-session")) return;
        context.report({ node, message: MESSAGE });
      },
      CallExpression(node) {
        if (!composerFile) return;
        if (node.callee.type !== "Identifier" || !SESSION_SCOPE_CALLS.has(node.callee.name)) return;
        context.report({ node, message: MESSAGE });
      },
    };
  },
});
