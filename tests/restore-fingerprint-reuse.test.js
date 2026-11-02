#!/usr/bin/env node
/**
 * Regression test — a state restore must not re-hash or re-fetch a disk it
 * already loaded.
 *
 * Background (2026-11-02): restoring a large RP state held
 * "Restoring the machine state…" for ~11 s. The image identity was computed
 * with the JavaScript SHA-256 over a 166 MiB payload FOUR times per restore,
 * and the pinned image was fetched twice. Three rules keep that from coming
 * back, and this test pins all three:
 *
 *   1. ImageFingerprint.asyncOfBytes() is the platform hasher and returns the
 *      same 64 lowercase hex digits as the synchronous loop.
 *   2. DataLoader.mount() honours a fingerprint handed to it and does not
 *      hash the payload again.
 *   3. VersionedMedia.load() answers a repeated request from the identity
 *      registered when the disk was mounted — no second fetch, no second hash.
 *
 * Run with: node tests/restore-fingerprint-reuse.test.js
 */
"use strict";

const assert = require("assert");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// ------------------------------------------------------------------
// 1. asyncOfBytes === ofBytes
// ------------------------------------------------------------------
async function testAsyncIdentity() {
  const { ImageFingerprint } = require(path.join(ROOT, "src", "imagefingerprint.js"));
  const payload = new Uint8Array(300000);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;

  const sync = ImageFingerprint.ofBytes(payload);
  const asyncSha = await ImageFingerprint.asyncOfBytes(payload);
  assert.strictEqual(asyncSha, sync, "asyncOfBytes must agree with ofBytes");
  assert.match(asyncSha, /^[0-9a-f]{64}$/, "identity is 64 lowercase hex digits");
  assert.strictEqual(await ImageFingerprint.asyncOfBytes(new Uint8Array(0)), null,
    "no bytes -> no identity");
  console.log("PASS 1: asyncOfBytes() matches ofBytes() and stays hex");
}

// ------------------------------------------------------------------
// 2. DataLoader.mount() trusts a supplied fingerprint
// ------------------------------------------------------------------
function loadDataLoader() {
  // The module reads DiskStore/ImageFingerprint as globals AT CALL TIME, so the
  // stubs installed by the test must survive the require.
  const p = path.join(ROOT, "src", "dataloader.js");
  delete require.cache[require.resolve(p)];
  delete global.DataLoader;
  const before = global.window;
  global.window = undefined;
  const mod = require(p);
  global.window = before;
  return mod.DataLoader;
}

function testMountHonoursFingerprint() {
  const registered = [];
  let hashed = 0;
  global.DiskStore = {
    registerImage(url, fp) { registered.push([url, fp]); }
  };
  global.ImageFingerprint = {
    ofBytes() { hashed++; return "hashed-by-mount"; }
  };

  const DataLoader = loadDataLoader();
  const bytes = new Uint8Array([1, 2, 3, 4]);

  DataLoader.mount("rk0.dsk", bytes, "network", "known-digest");
  assert.deepStrictEqual(registered.pop(), ["rk0.dsk", "known-digest"],
    "the supplied identity is what gets registered");
  assert.strictEqual(hashed, 0, "a supplied identity must not be re-hashed");

  DataLoader.mount("rk1.dsk", bytes, "network");
  assert.strictEqual(hashed, 1, "without a supplied identity the payload is hashed");
  assert.deepStrictEqual(registered.pop(), ["rk1.dsk", "hashed-by-mount"]);
  console.log("PASS 2: DataLoader.mount() does not re-hash a known identity");
}

// ------------------------------------------------------------------
// 3. VersionedMedia.load() reuses what the machine already holds
// ------------------------------------------------------------------
async function testVersionedReuse() {
  const DATA = new Uint8Array(4096).fill(9);
  const SHA = require("crypto").createHash("sha256").update(Buffer.from(DATA)).digest("hex");

  const mounts = [];
  const known = new Map();
  let fetches = 0;
  let syncHashes = 0;
  let asyncHashes = 0;

  global.DataLoader = {
    has(url) { return known.has(url); },
    get(url) { return known.get(url); },
    mount(url, bytes, source, fp) {
      mounts.push([url, source, fp]);
      known.set(url, bytes);
      if (fp) known.set(url + "|fp", fp);
    }
  };
  global.DiskStore = {
    registerImage(url, fp) { known.set(url + "|fp", fp); },
    fingerprintOf(url) { return known.get(url + "|fp") || null; }
  };
  global.ImageFingerprint = {
    ofBytes() { syncHashes++; return ImageFingerprintSync(); },
    asyncOfBytes() { asyncHashes++; return Promise.resolve(ImageFingerprintSync()); }
  };
  function ImageFingerprintSync() {
    return require("crypto").createHash("sha256").update(Buffer.from(DATA)).digest("hex");
  }

  global.fetch = (url) => {
    if (/manifest\.json$/.test(url)) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          "media-versioned": { "rk1.dsk": { versions: { 1: { version: 1, sha256: SHA, url: "media/rk1.v1.dsk" } } } }
        })
      });
    }
    fetches++;
    return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(DATA.buffer) });
  };

  const p = path.join(ROOT, "src", "media-registry.js");
  delete require.cache[require.resolve(p)];
  const { VersionedMedia } = require(p);

  await VersionedMedia.load("rk1.dsk", 1, SHA);
  assert.strictEqual(fetches, 1, "the first load fetches the image");
  assert.strictEqual(asyncHashes, 1, "the downloaded payload is verified once");
  assert.strictEqual(syncHashes, 0, "the platform hasher replaces the JS loop");
  assert.strictEqual(mounts.length, 1, "the verified image is mounted once");
  assert.strictEqual(mounts[0][2], SHA, "the mount receives the verified identity");

  await VersionedMedia.load("rk1.dsk", 1, SHA);
  assert.strictEqual(fetches, 1, "the second load must NOT fetch the image again");
  assert.strictEqual(asyncHashes, 1, "the second load must NOT hash the payload again");
  assert.strictEqual(syncHashes, 0, "no JavaScript SHA-256 on the mounted payload");
  assert.strictEqual(mounts.length, 1, "re-mounting would lie about the image source");
  console.log("PASS 3: a repeated versioned load costs neither a fetch nor a hash");
}

(async () => {
  await testAsyncIdentity();
  testMountHonoursFingerprint();
  await testVersionedReuse();
  console.log("\nAll restore-fingerprint-reuse tests passed.");
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
