#!/usr/bin/env node
// Only these reviewed files leave the private repository. No recursive repo copy.
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2];
if (!output || process.argv.length !== 3) throw new Error("Usage: node scripts/export-skills.mjs <new-output-directory>");
const destination = resolve(output);
await mkdir(dirname(destination), { recursive: true });
await mkdir(destination); // Refuse an existing directory, including a previous export.

async function emit(target, content) {
  const filename = resolve(destination, target);
  await mkdir(dirname(filename), { recursive: true });
  await writeFile(filename, content, { flag: "wx" });
}
async function copy(source, target = source) {
  const filename = resolve(destination, target);
  await mkdir(dirname(filename), { recursive: true });
  await copyFile(resolve(root, source), filename);
}
function replaceRequired(source, before, after) {
  if (!source.includes(before)) throw new Error(`Export transformation no longer matches: ${before}`);
  return source.replace(before, after);
}

const recorder = "skills/chronosphere-record";
const reconstruction = "skills/chronosphere-reconstruct";
for (const name of ["README.md", "LICENSE", "package.json"]) await copy(`skills/distribution/${name}`, name);
await copy("skills/distribution/ci.yml", ".github/workflows/ci.yml");
await emit(".gitignore", "node_modules/\n__pycache__/\n*.pyc\n.DS_Store\n.chronosphere/\n");
for (const name of ["scripts/record.mjs", "lib/recording.ts", "lib/recording-transport.ts"]) await copy(name, `${recorder}/${name}`);
for (const name of ["SKILL.md", "references/format.md", "scripts/reconstruct.py"]) await copy(`${reconstruction}/${name}`);
for (const skill of [recorder, reconstruction]) await copy("skills/distribution/LICENSE", `${skill}/LICENSE`);

let instructions = await readFile(resolve(root, "SKILL.md"), "utf8");
instructions = replaceRequired(instructions, "beside this root-level skill", "bundled with this skill");
instructions = replaceRequired(instructions,
  'read the repository\'s `README.md` section “Local recording experiment” when needed.',
  'read [recording details](references/recording.md) when needed. The bundled helpers require no application installation or npm dependencies.');
await emit(`${recorder}/SKILL.md`, instructions);
const readme = await readFile(resolve(root, "README.md"), "utf8");
const details = readme.match(/\*\*Where the record lives\.\*\*[\s\S]*?(?=\n## Local setup)/)?.[0];
if (!details) throw new Error("Recording reference section was not found");
await emit(`${recorder}/references/recording.md`, "# Recording details\n\n" + details.trim() + "\n");

for (const name of ["recording.test.mjs", "recording-transport.test.mjs", "reconstruct.test.mjs"]) {
  let source = await readFile(resolve(root, "tests", name), "utf8");
  source = source.replaceAll('"../lib/recording', '"../skills/chronosphere-record/lib/recording');
  if (name === "recording.test.mjs") {
    source = replaceRequired(source, 'resolve("scripts/record.mjs")', 'resolve("skills/chronosphere-record/scripts/record.mjs")');
    source = replaceRequired(source, 'symlink(resolve("."), alias', 'symlink(resolve("skills/chronosphere-record"), alias');
  }
  await emit(`tests/${name}`, source);
}
console.log(`Exported public skill files to ${destination}. Run npm test there before publishing.`);
