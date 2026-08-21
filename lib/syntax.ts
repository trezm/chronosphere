import { tokenize, type ShjToken } from "@speed-highlight/core";
import { detectLanguage } from "@speed-highlight/core/detect";

export interface SyntaxToken {
  text: string;
  type?: ShjToken;
}

const LANGUAGES_BY_EXTENSION: Record<string, string> = {
  asm: "asm",
  bash: "bash",
  c: "c",
  cc: "c",
  cjs: "js",
  cpp: "c",
  cs: "java",
  css: "css",
  csv: "csv",
  cxx: "c",
  go: "go",
  h: "c",
  hpp: "c",
  htm: "html",
  html: "html",
  ini: "ini",
  java: "java",
  js: "js",
  json: "json",
  json5: "json",
  jsonc: "json",
  jsx: "js",
  kt: "java",
  kts: "java",
  less: "css",
  lua: "lua",
  md: "md",
  mdx: "md",
  mjs: "js",
  mts: "ts",
  pl: "pl",
  pm: "pl",
  py: "py",
  rs: "rs",
  sass: "css",
  scss: "css",
  sh: "bash",
  sql: "sql",
  svelte: "html",
  svg: "xml",
  toml: "toml",
  ts: "ts",
  tsx: "ts",
  vue: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

export function languageForPath(path: string, source = ""): string {
  const filename = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (/^(dockerfile|containerfile)(\..+)?$/.test(filename)) return "docker";
  if (/^(gnu)?makefile$/.test(filename)) return "make";

  const extension = filename.includes(".") ? filename.split(".").at(-1) ?? "" : "";
  return LANGUAGES_BY_EXTENSION[extension] ?? (source.trim() ? detectLanguage(source) : "plain");
}

export async function highlightLines(lines: string[], language: string): Promise<SyntaxToken[][]> {
  if (!lines.length) return [];
  if (language === "plain") return lines.map((text) => text ? [{ text }] : []);

  const highlighted: SyntaxToken[][] = [[]];
  try {
    await tokenize(lines.join("\n"), language, (text, type) => {
      const pieces = text.split("\n");
      pieces.forEach((piece, index) => {
        if (piece) highlighted.at(-1)?.push({ text: piece, type });
        if (index < pieces.length - 1) highlighted.push([]);
      });
    });
    while (highlighted.length < lines.length) highlighted.push([]);
    return highlighted.slice(0, lines.length);
  } catch {
    return lines.map((text) => text ? [{ text }] : []);
  }
}
