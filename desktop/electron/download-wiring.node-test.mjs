import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const mainSource = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function downloadWiring() {
  const source = mainSource.match(/const downloadHandlerSessions = new WeakSet\(\);\nfunction installDownloadHandler\(targetSession\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(source, "main must define the shared session download installer");
  const calls = [];
  const context = vm.createContext({
    app: { getPath: name => { assert.equal(name, "downloads"); return "/downloads"; } },
    collisionFreeDownloadPath: (directory, filename) => {
      calls.push(["path", directory, filename]);
      return "/downloads/sanitized-collision-free-name";
    },
    revealDownloadWhenDone: (item, reveal) => { calls.push(["completion", item]); reveal("/downloads/completed"); },
    shell: { showItemInFolder: filePath => calls.push(["reveal", filePath]) },
  });
  vm.runInContext(`${source}\nglobalThis.install = installDownloadHandler;`, context);
  return { install: context.install, calls };
}

test("download wiring installs once per session, including account reuse", () => {
  const { install } = downloadWiring();
  const defaultSession = new EventEmitter();
  const accountA = new EventEmitter();
  const accountB = new EventEmitter();
  for (const target of [defaultSession, accountA, accountA, accountB, defaultSession, accountA]) install(target);
  for (const target of [defaultSession, accountA, accountB]) {
    assert.equal(target.listenerCount("will-download"), 1);
  }
});

test("default and account sessions delegate unchanged to the safe download helpers", () => {
  const { install, calls } = downloadWiring();
  for (const target of [new EventEmitter(), new EventEmitter()]) {
    install(target);
    const saved = [];
    const item = {
      getFilename: () => "../../untrusted-name.txt",
      setSavePath: value => saved.push(value),
    };
    target.emit("will-download", {}, item);
    assert.deepEqual(saved, ["/downloads/sanitized-collision-free-name"]);
    assert.deepEqual(calls.splice(0), [
      ["path", "/downloads", "../../untrusted-name.txt"],
      ["completion", item],
      ["reveal", "/downloads/completed"],
    ]);
  }
});

test("product runtime wires its partition before server setup or window navigation", () => {
  const start = mainSource.indexOf("async function startProductDesktop()");
  const ready = mainSource.indexOf("app.whenReady().then", start);
  assert.ok(start >= 0 && ready > start);
  const product = mainSource.slice(start, ready);
  assert.match(product, /const accountSession = session\.fromPartition\(`persist:product-\$\{accountKey\}`\);\s*installDownloadHandler\(accountSession\);\s*installServerSessions\(/);
  const install = product.indexOf("installDownloadHandler(accountSession)");
  const navigate = product.indexOf("createWindow();");
  assert.ok(install >= 0 && navigate > install, "account listener must precede workspace window creation");
  assert.match(mainSource.slice(ready), /if \(productService\) \{ await startProductDesktop\(\); return; \}/);
  assert.match(mainSource.slice(ready), /installDownloadHandler\(session\.defaultSession\);/);
  assert.equal((mainSource.match(/\.on\("will-download"/g) ?? []).length, 1, "both paths must share the only download callback");
});
