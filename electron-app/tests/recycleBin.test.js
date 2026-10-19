const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const rb = require("./recycleBin.js");

function filetime(ms) { return (BigInt(ms) + 11644473600000n) * 10000n; }
function recordV2(originalPath, size, deletedMs) {
  const p = Buffer.from(originalPath + "\0", "utf16le");
  const b = Buffer.alloc(28 + p.length);
  b.writeBigInt64LE(2n, 0); b.writeBigInt64LE(BigInt(size), 8); b.writeBigUInt64LE(filetime(deletedMs), 16);
  b.writeUInt32LE(originalPath.length + 1, 24); p.copy(b, 28); return b;
}
function recordV1(originalPath, size, deletedMs) {
  const b = Buffer.alloc(24 + 520);
  b.writeBigInt64LE(1n, 0); b.writeBigInt64LE(BigInt(size), 8); b.writeBigUInt64LE(filetime(deletedMs), 16);
  Buffer.from(originalPath + "\0", "utf16le").copy(b, 24); return b;
}

// ---- parser
const T0 = Date.UTC(2026, 9, 1, 14, 17, 49);
let r = rb.parseInfoRecord(recordV2("C:\\Users\\user\\Downloads\\pdf (2)", 2064384, T0));
assert.deepEqual(r, { size: 2064384, deletedMs: T0, originalPath: "C:\\Users\\user\\Downloads\\pdf (2)" });
r = rb.parseInfoRecord(recordV1("C:\\Users\\user\\Desktop\\Résumé – 日本語.docx", 1234, T0 + 5000));
assert.equal(r.originalPath, "C:\\Users\\user\\Desktop\\Résumé – 日本語.docx"); assert.equal(r.deletedMs, T0 + 5000);
assert.equal(rb.parseInfoRecord(Buffer.alloc(10)), null, "too short");
const badVer = recordV2("C:\\x", 1, T0); badVer.writeBigInt64LE(7n, 0); assert.equal(rb.parseInfoRecord(badVer), null, "unknown version");
const zeroLen = recordV2("C:\\x", 1, T0); zeroLen.writeUInt32LE(0, 24); assert.equal(rb.parseInfoRecord(zeroLen), null, "zero length");
const hugeLen = recordV2("C:\\x", 1, T0); hugeLen.writeUInt32LE(99999999, 24); assert.equal(rb.parseInfoRecord(hugeLen), null, "absurd length");
console.log("parser: ok");

// ---- fake bin
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rb-"));
const outside = path.join(root, "outside"); fs.mkdirSync(outside);
const sentinel = path.join(outside, "keep-me.txt"); fs.writeFileSync(sentinel, "precious");
const restoreArea = path.join(root, "restored"); fs.mkdirSync(restoreArea);

function makeBin(name) {
  const dir = path.join(root, name, "$Recycle.Bin", "S-1-5-21-1");
  fs.mkdirSync(dir, { recursive: true });
  return { drive: name === "C" ? "C" : "D", dir };
}
function addItem(bin, suffix, originalPath, content, ms, size) {
  fs.writeFileSync(path.join(bin.dir, "$I" + suffix), recordV2(originalPath, size ?? content.length, ms));
  if (content === null) fs.mkdirSync(path.join(bin.dir, "$R" + suffix));
  else fs.writeFileSync(path.join(bin.dir, "$R" + suffix), content);
}
const C = makeBin("C"), D = makeBin("D");
addItem(C, "AAA111.pdf", path.join(restoreArea, "a.pdf"), "pdfdata", T0 + 3000);
addItem(C, "BBB222", path.join(restoreArea, "folderB"), null, T0 + 2000, 5000);
fs.writeFileSync(path.join(C.dir, "$RBBB222", "inner.txt"), "x");
fs.mkdirSync(path.join(C.dir, "$RBBB222", "deep", "er"), { recursive: true });
fs.writeFileSync(path.join(C.dir, "$RBBB222", "deep", "er", "ro.txt"), "readonly"); fs.chmodSync(path.join(C.dir, "$RBBB222", "deep", "er", "ro.txt"), 0o444);
addItem(C, "CCC333.jpg", path.join(restoreArea, "sub", "missingparent", "c.jpg"), "jpg", T0 + 1000);
addItem(D, "DDD444.txt", path.join(restoreArea, "d.txt"), "dtext", T0 + 4000);
// orphans: info without item, item without info, unreadable record
fs.writeFileSync(path.join(C.dir, "$IORPH1.doc"), recordV2("C:\\gone.doc", 1, T0));
fs.writeFileSync(path.join(C.dir, "$RORPH2.bin"), "lonely");
fs.writeFileSync(path.join(C.dir, "$IJUNK3.txt"), Buffer.from("not a record at all......................"));
fs.writeFileSync(path.join(C.dir, "$RJUNK3.txt"), "data");
fs.writeFileSync(path.join(C.dir, "desktop.ini"), "[x]");
// a symlink "item" pointing at an outside folder: deleting must remove the link only
fs.symlinkSync(outside, path.join(C.dir, "$RLINK555"), "dir");
fs.writeFileSync(path.join(C.dir, "$ILINK555"), recordV2(path.join(restoreArea, "linked"), 0, T0 + 500));

(async () => {
  const dirs = [C, D];
  // ---- list
  let l = await rb.listRecycleBin(dirs);
  assert.equal(l.supported, true);
  assert.deepEqual(l.entries.map((e) => e.name), ["d.txt", "a.pdf", "folderB", "c.jpg", "linked"]);   // newest first, orphans/junk hidden
  assert.deepEqual(l.entries.map((e) => e.id), ["D:DDD444.txt", "C:AAA111.pdf", "C:BBB222", "C:CCC333.jpg", "C:LINK555"]);
  assert.equal(l.entries.find((e) => e.name === "folderB").isDirectory, true);
  assert.equal(l.entries.find((e) => e.name === "a.pdf").isDirectory, false);
  assert.equal(l.totalSize, l.entries.reduce((n, e) => n + e.size, 0));
  console.log("list: ok", l.entries.length, "entries");

  // ---- invalid / hostile ids delete nothing
  const hostile = ["../../outside/keep-me.txt", "C:../../outside/keep-me.txt", "C:..", "C:.", "C:a/b", "C:a\\b", "Z:AAA111.pdf", "", 42, null, { id: "C:AAA111.pdf" }, "C:", "C:NOPE999"];
  let res = await rb.deleteFromRecycleBin(hostile, dirs);
  assert.equal(res.done, 0); assert.equal(res.failed.length, 10, "10 distinct ids (all non-strings collapse to one), every one rejected");
  assert.ok(fs.existsSync(sentinel), "outside file must survive"); assert.equal(fs.readFileSync(sentinel, "utf8"), "precious");
  assert.equal((await rb.listRecycleBin(dirs)).entries.length, 5, "nothing in the bin changed");
  res = await rb.deleteFromRecycleBin("not-an-array", dirs); assert.equal(res.done, 0); assert.equal(res.failed.length, 1);
  console.log("hostile ids: rejected, nothing touched");

  // ---- restore: missing parent gets created; existing target is never overwritten
  fs.writeFileSync(path.join(restoreArea, "a.pdf"), "ALREADY HERE");
  res = await rb.restoreFromRecycleBin(["C:AAA111.pdf", "C:CCC333.jpg", "C:BBB222"], dirs);
  assert.equal(res.done, 2);
  assert.equal(res.failed.length, 1); assert.equal(res.failed[0].id, "C:AAA111.pdf"); assert.match(res.failed[0].error, /already exists/);
  assert.equal(fs.readFileSync(path.join(restoreArea, "a.pdf"), "utf8"), "ALREADY HERE", "not overwritten");
  assert.equal(fs.readFileSync(path.join(restoreArea, "sub", "missingparent", "c.jpg"), "utf8"), "jpg");
  assert.equal(fs.readFileSync(path.join(restoreArea, "folderB", "inner.txt"), "utf8"), "x");
  assert.ok(!fs.existsSync(path.join(C.dir, "$ICCC333.jpg")) && !fs.existsSync(path.join(C.dir, "$RCCC333.jpg")), "restored item leaves the bin");
  assert.ok(fs.existsSync(path.join(C.dir, "$IAAA111.pdf")) && fs.existsSync(path.join(C.dir, "$RAAA111.pdf")), "failed restore leaves the entry in the bin");
  console.log("restore: ok");

  // ---- delete selected: only those go; readonly + nested content handled
  addItem(C, "EEE666", path.join(restoreArea, "tree"), null, T0 + 9000, 1);
  fs.mkdirSync(path.join(C.dir, "$REEE666", "n"), { recursive: true });
  fs.writeFileSync(path.join(C.dir, "$REEE666", "n", "ro.txt"), "ro"); fs.chmodSync(path.join(C.dir, "$REEE666", "n", "ro.txt"), 0o444);
  res = await rb.deleteFromRecycleBin(["C:EEE666", "D:DDD444.txt", "C:EEE666" /* duplicate */], dirs);
  assert.equal(res.done, 2); assert.deepEqual(res.failed, []);
  assert.ok(!fs.existsSync(path.join(C.dir, "$REEE666")) && !fs.existsSync(path.join(C.dir, "$IEEE666")));
  assert.ok(!fs.existsSync(path.join(D.dir, "$RDDD444.txt")) && !fs.existsSync(path.join(D.dir, "$IDDD444.txt")));
  assert.ok(fs.existsSync(path.join(C.dir, "$RAAA111.pdf")), "unselected item untouched");
  console.log("delete selected: ok");

  // ---- symlink item: link removed, target untouched
  res = await rb.deleteFromRecycleBin(["C:LINK555"], dirs);
  assert.equal(res.done, 1);
  assert.ok(!fs.existsSync(path.join(C.dir, "$RLINK555")) && !fs.lstatSync(outside).isSymbolicLink());
  assert.equal(fs.readFileSync(sentinel, "utf8"), "precious", "symlink target must survive");
  console.log("symlink: link removed, target safe");

  // ---- empty: everything, including orphans/junk, but not desktop.ini or anything outside
  res = await rb.emptyRecycleBin(dirs);
  assert.deepEqual(res.failed, []);
  assert.deepEqual(fs.readdirSync(C.dir).sort(), ["desktop.ini"]);
  assert.deepEqual(fs.readdirSync(D.dir), []);
  assert.equal((await rb.listRecycleBin(dirs)).entries.length, 0);
  assert.ok(fs.existsSync(sentinel) && fs.existsSync(path.join(restoreArea, "folderB", "inner.txt")), "files outside the bin survive");
  console.log("empty: ok");

  // ---- unsupported platform without injected dirs
  if (process.platform !== "win32") { const u = await rb.listRecycleBin(); assert.deepEqual(u, { supported: false, entries: [], totalSize: 0 }); await assert.rejects(rb.emptyRecycleBin(), /only available on Windows/); console.log("non-Windows: reports unsupported"); }
  fs.rmSync(root, { recursive: true, force: true });
  console.log("\nALL RECYCLE BIN TESTS PASSED");
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
