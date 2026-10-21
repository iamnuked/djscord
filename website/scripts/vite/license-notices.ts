import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Plugin } from "vite";

interface PackageNotice {
  name: string;
  version: string;
  license: string;
  source: string;
  documents: { name: string; text: string }[];
}

const allowedLicenses = new Set([
  "MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD",
  "MIT OR Apache-2.0", "(MIT OR Apache-2.0)", "BlueOak-1.0.0"
]);

function packageForModule(id: string, root: string): PackageNotice | undefined {
  const file = id.replace(/^\0/, "").split("?")[0]!;
  if (!isAbsolute(file) || !file.includes("/node_modules/") || !existsSync(file)) return;
  for (let directory = dirname(file); ; directory = dirname(directory)) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name && manifest.version) {
        const label = `${manifest.name}@${manifest.version}`;
        if (!allowedLicenses.has(manifest.license)) {
          throw new Error(`Review bundled license before publishing ${label}: ${manifest.license}. Add the required notices/source offer before updating this policy.`);
        }
        const documents = readdirSync(directory)
          .filter((name) => /^(licen[sc]e|notice|copying)([.-]|$)/i.test(name))
          .sort().map((name) => ({ name, text: readFileSync(join(directory, name), "utf8").trim() }));
        if (label === "@vitejs/plugin-rsc@0.5.26" && documents.length === 0) {
          documents.push({ name: "upstream LICENSE", text: readFileSync(join(root, "legal/Vite-Plugin-React-MIT.txt"), "utf8").trim() });
        }
        if (!documents.some(({ name }) => /^(?:upstream )?(licen[sc]e|copying)/i.test(name))) {
          throw new Error(`Missing bundled license text: ${label}`);
        }
        return {
          name: manifest.name, version: manifest.version, license: manifest.license,
          source: `https://www.npmjs.com/package/${manifest.name}/v/${manifest.version}`,
          documents
        };
      }
    }
    if (dirname(directory) === directory) throw new Error(`Cannot identify package for bundled module: ${id}`);
  }
}

/** Track rendered modules, rather than treating every build dependency as shipped code. */
export function licenseNotices(): Plugin {
  let root = "";
  const packages = new Map<string, PackageNotice>();
  return {
    name: "djscord-license-notices",
    apply: "build",
    configResolved(config) { root = config.root; },
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        for (const [id, module] of Object.entries(chunk.modules)) {
          if (module.renderedLength === 0) continue;
          const notice = packageForModule(id, root);
          if (notice) packages.set(`${notice.name}@${notice.version}`, notice);
        }
        for (const external of [...chunk.imports, ...chunk.dynamicImports]) {
          if (external.startsWith(".") || external.startsWith("/") || external in bundle ||
              external.startsWith("node:") || external.startsWith("cloudflare:")) continue;
          // Vite RSC analysis passes leave generated virtual modules external until the final build.
          if (external.startsWith("virtual:")) continue;
          throw new Error(`Unaccounted external dependency in distributed web bundle: ${external}`);
        }
      }
      const rows = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
      const noticeText = [
        "djscord website — bundled third-party notices",
        "Generated from rendered JavaScript modules. Build tools not present in the bundle are not listed.",
        ...rows.map((row) => [
          `${row.name}@${row.version} (${row.license})`, row.source,
          ...row.documents.map(({ name, text }) => `--- ${name} ---\n${text}`)
        ].join("\n\n")),
        "Geist and Geist Mono — SIL Open Font License 1.1\nSee legal/Geist-OFL.txt (included with this distribution)."
      ].join("\n\n============================================================\n\n") + "\n";
      this.emitFile({ type: "asset", fileName: "legal/third-party-notices.txt", source: noticeText });
      this.emitFile({ type: "asset", fileName: "legal/third-party-packages.json", source: JSON.stringify(rows.map(({ documents, ...row }) => ({ ...row, documents: documents.map(({ name }) => name) })), null, 2) + "\n" });
      this.emitFile({ type: "asset", fileName: "legal/LICENSE.txt", source: readFileSync(join(root, "LICENSE"), "utf8") });
      this.emitFile({ type: "asset", fileName: "legal/Geist-OFL.txt", source: readFileSync(join(root, "legal/Geist-OFL.txt"), "utf8") });
    }
  };
}
