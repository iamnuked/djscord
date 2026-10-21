import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async (request) => {
      const asset = new URL(`../dist/client${new URL(request.url).pathname}`, import.meta.url);
      return existsSync(asset)
        ? new Response(readFileSync(asset), { headers: { "Content-Type": asset.pathname.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8" } })
        : new Response("Not found", { status: 404 });
    } } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the djscord landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>djscord — 서버의 순간을 음악으로<\/title>/i);
  assert.match(html, /우리 서버의 분위기를/);
  assert.match(html, /COMMUNITY|커뮤니티/i);
  assert.match(html, /FEATURES/);
  assert.match(html, /COMMANDS/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
  assert.match(html, /href="\/legal\/third-party-notices\.txt"/);
  assert.match(html, /href="\/legal\/Geist-OFL\.txt"/);
  assert.doesNotMatch(html, /\/og\.png/);
});

test("serves copyright and font license texts with the built website", async () => {
  for (const [pathname, expected] of [
    ["/legal/third-party-notices.txt", /Meta Platforms, Inc\. and affiliates/],
    ["/legal/Geist-OFL.txt", /Copyright 2024 The Geist Project Authors/],
    ["/legal/LICENSE.txt", /Copyright \(c\) 2026 iamnuked/]
  ]) {
    const response = await render(pathname);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/plain/);
    assert.match(await response.text(), expected);
  }
  const response = await render("/legal/third-party-packages.json");
  assert.equal(response.status, 200);
  const packages = await response.json();
  assert.ok(packages.some(({ name }) => name === "react"));
  assert.ok(packages.some(({ name }) => name === "vinext"));
  const serverPackages = JSON.parse(readFileSync(new URL("../dist/server/legal/third-party-packages.json", import.meta.url)));
  assert.deepEqual(packages, serverPackages);
});

test("the release contains fonts and excludes local artwork and native/WASM dependencies", () => {
  const files = readdirSync(fileURLToPath(new URL("../dist", import.meta.url)), { recursive: true });
  assert.ok(files.some((name) => name.endsWith(".woff2")));
  assert.ok(files.some((name) => name.endsWith("Geist-OFL.txt")));
  assert.equal(files.some((name) => /(?:og\.png|AppIcon\.(?:png|icns)|\.(?:wasm|node|dylib|so))$/i.test(name)), false);
});

test("the retired live mix page is unavailable", async () => {
  const response = await render("/mix");
  assert.equal(response.status, 404);
});
