import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const inventories = [];
function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) scan(file);
    else if (entry.name === "third-party-packages.json") inventories.push(file);
    else if (/\.(?:wasm|node|dylib|so(?:\.\d+)*)$/i.test(entry.name)) {
      throw new Error(`Review native/WASM distribution and its source obligations: ${relative(dist, file)}`);
    }
  }
}
scan(dist);
if (!inventories.length) throw new Error("No bundle license inventories were generated.");
const packages = new Map();
const notices = ["djscord website — notices for all distributed client and server bundles"];
for (const file of inventories.sort()) {
  for (const entry of JSON.parse(readFileSync(file, "utf8"))) {
    packages.set(`${entry.name}@${entry.version}`, entry);
  }
  notices.push(`${relative(dist, dirname(file))}\n\n${readFileSync(join(dirname(file), "third-party-notices.txt"), "utf8")}`);
}
const rows = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
for (const directory of [join(dist, "client/legal"), join(dist, "server/legal")]) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "third-party-packages.json"), JSON.stringify(rows, null, 2) + "\n");
  writeFileSync(join(directory, "third-party-notices.txt"), notices.join("\n\n============================================================\n\n") + "\n");
}
console.info(`Included copyright/license notices for ${rows.length} bundled web package versions and Geist fonts.`);
