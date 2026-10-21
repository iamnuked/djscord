import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "vite";
import { licenseNotices } from "../scripts/vite/license-notices";

test("publishing a newly bundled LGPL dependency requires an explicit license review", async () => {
  const root = mkdtempSync(join(tmpdir(), "djscord-license-policy-"));
  try {
    const dependency = join(root, "node_modules", "new-copyleft-dependency");
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "new-copyleft-dependency", version: "1.0.0", license: "LGPL-3.0-or-later", main: "index.js", type: "module" }));
    writeFileSync(join(dependency, "index.js"), "export const result = 'new dependency';\n");
    writeFileSync(join(dependency, "LICENSE"), "Fixture LGPL license text\n");
    writeFileSync(join(root, "index.js"), "export { result } from 'new-copyleft-dependency';\n");
    cpSync(new URL("../LICENSE", import.meta.url), join(root, "LICENSE"));
    mkdirSync(join(root, "legal"));
    cpSync(new URL("../legal/Geist-OFL.txt", import.meta.url), join(root, "legal/Geist-OFL.txt"));
    await assert.rejects(build({
      configFile: false, root, publicDir: false, logLevel: "silent",
      plugins: [licenseNotices()],
      build: { write: false, lib: { entry: join(root, "index.js"), formats: ["es"] } }
    }), /Review bundled license.*LGPL-3\.0-or-later/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
