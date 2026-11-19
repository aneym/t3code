import type { Plugin } from "vite-plus";

const EMBED_THREAD_ROUTE = /[\\/]routes[\\/]embed\.\$environmentId\.\$threadId\.tsx/;

export function embedPreloadPlugin(): Plugin {
  let base = "/";
  return {
    name: "t3code:embed-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const bundle = ctx.bundle;
        if (bundle === undefined) return;
        const route = Object.values(bundle).find(
          (output) =>
            output.type === "chunk" && EMBED_THREAD_ROUTE.test(output.facadeModuleId ?? ""),
        );
        if (route?.type !== "chunk") return;
        const scripts = new Set<string>();
        const styles = new Set<string>();
        const visit = (fileName: string) => {
          const chunk = bundle[fileName];
          if (chunk?.type !== "chunk" || scripts.has(fileName)) return;
          scripts.add(fileName);
          for (const css of chunk.viteMetadata?.importedCss ?? []) styles.add(css);
          for (const imported of chunk.imports) visit(imported);
        };
        visit(route.fileName);
        const links = [
          ...[...scripts].map((file) => ["modulepreload", base + file]),
          ...[...styles].map((file) => ["stylesheet", base + file]),
        ];
        return [
          {
            tag: "script",
            injectTo: "head",
            children: `if(location.pathname.startsWith("/embed/"))for(const[r,h]of ${JSON.stringify(links)}){const l=document.createElement("link");l.rel=r;l.href=h;if(r==="modulepreload")l.crossOrigin="";document.head.append(l)}`,
          },
        ];
      },
    },
  };
}
