import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = new Map();

function locate(name, from) {
  for (let directory = from; ; directory = dirname(directory)) {
    const file = join(directory, "node_modules", name, "package.json");
    if (existsSync(file)) return realpathSync(file);
    if (dirname(directory) === directory) throw new Error(`Missing runtime dependency: ${name}`);
  }
}

function visit(name, from) {
  const file = locate(name, from);
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const id = `${manifest.name}@${manifest.version}`;
  if (packages.has(id)) return;
  if (!["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD"].includes(manifest.license)) {
    throw new Error(`Review runtime license before distributing ${id}: ${manifest.license}`);
  }
  const directory = dirname(file);
  const documents = readdirSync(directory).filter((name) => /^(licen[sc]e|notice|copying)([.-]|$)/i.test(name));
  const upstreamFallback = new Set(["@sapphire/async-queue@1.5.5", "@sapphire/snowflake@3.5.5"]).has(id)
    ? [{ name: "upstream LICENSE.md", text: readFileSync(join(root, "licenses/sapphire-utilities-LICENSE.md"), "utf8").trim() }]
    : [];
  if (!documents.some((name) => /^(licen[sc]e|copying)/i.test(name)) && upstreamFallback.length === 0) {
    throw new Error(`Missing license text: ${id}`);
  }
  packages.set(id, {
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    source: `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`,
    documents: [...documents.sort().map((name) => ({ name, text: readFileSync(join(directory, name), "utf8").trim() })), ...upstreamFallback]
  });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, directory);
  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
    try { locate(dependency, directory); } catch { continue; }
    visit(dependency, directory);
  }
  for (const dependency of Object.keys(manifest.peerDependencies ?? {})) {
    try { locate(dependency, directory); } catch (error) {
      if (manifest.peerDependenciesMeta?.[dependency]?.optional) continue;
      throw error;
    }
    visit(dependency, directory);
  }
}

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
for (const name of Object.keys(manifest.dependencies)) visit(name, root);
const rows = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const output = join(root, "licenses", "bot");
mkdirSync(output, { recursive: true });
writeFileSync(join(output, "packages.json"), `${JSON.stringify(rows.map(({ documents, ...row }) => ({ ...row, documents: documents.map(({ name }) => name) })), null, 2)}\n`);
writeFileSync(join(output, "THIRD_PARTY_NOTICES.txt"), [
  "djscord bot — runtime third-party notices",
  "Generated from installed runtime dependencies. Keep the original notices in node_modules as well.",
  ...rows.map((row) => [
    `${row.name}@${row.version} (${row.license})`, row.source,
    ...row.documents.map(({ name, text }) => `--- ${name} ---\n${text}`)
  ].join("\n\n"))
].join("\n\n============================================================\n\n") + "\n");
console.info(`Generated runtime notices for ${rows.length} bot package versions.`);
