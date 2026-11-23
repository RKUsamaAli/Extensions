"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const CM_ENTRY = require("../lib/entry.js");
const CM_SITE = require("../lib/site-config.js");
const CM_MIGRATE = require("../lib/migrate.js");

const SEEDS = path.join(__dirname, "..", "..", "ext-hub", "seeds");
const seedConfig = () => JSON.parse(fs.readFileSync(path.join(SEEDS, "citamate-site-config.json"), "utf8"));
const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().trim();

// ---------- entry ----------
test("clean normalises document, name, year and type", () => {
  const e = CM_ENTRY.clean({ label: " Ali ", docType: "dni", docNumber: "12 345 678z", fullName: "ali khan", birthYear: "19-90x", id: "keep?" });
  assert.equal(e.label, "Ali");
  assert.equal(e.docType, "DNI");
  assert.equal(e.docNumber, "12345678Z");
  assert.equal(e.fullName, "ALI KHAN");
  assert.equal(e.birthYear, "1990");
  assert.equal(e.id, undefined, "the server assigns ids");
  assert.equal(CM_ENTRY.clean({ docType: "passport" }).docType, "NIE");
});

test("clean maps old free-text nationality to the catalog", () => {
  const paises = [{ value: "PAK", text: "PAKISTAN" }];
  const e = CM_ENTRY.clean({ nationality: "pakistan" }, paises);
  assert.equal(e.nationality, "PAK");
  assert.equal(e.nationalityText, "PAKISTAN");
  const u = CM_ENTRY.clean({ nationality: "ATLANTIS" }, paises);
  assert.equal(u.nationalityText, "ATLANTIS");
});

test("missing lists what the server requires; body keeps API fields only", () => {
  assert.deepEqual(CM_ENTRY.missing(CM_ENTRY.clean({})), ["Label", "Document number", "Full name"]);
  const b = CM_ENTRY.body({ id: "x", ownerId: "o", label: "L", createdAt: 1 });
  assert.equal(b.label, "L");
  assert.ok(!("id" in b) && !("ownerId" in b) && !("createdAt" in b));
  assert.deepEqual(Object.keys(b).sort(), CM_ENTRY.ALL_FIELDS.slice().sort());
});

test("very long values are cut at 500 chars", () => {
  assert.equal(CM_ENTRY.clean({ notes: "x".repeat(900) }).notes.length, 500);
});

// ---------- site config ----------
test("seed site config hydrates: patterns become RegExps", () => {
  const C = CM_SITE.hydrate(seedConfig());
  assert.ok(C.patterns.bookedText instanceof RegExp);
  assert.ok(C.stepButtons.Request.fallback.path instanceof RegExp);
  assert.ok(C.urlPages.every((p) => p.pattern instanceof RegExp));
  assert.ok(C.patterns.provinceName.flags.includes("i"));
});

test("seed config behaves like the old hard-coded constants", () => {
  const C = CM_SITE.hydrate(seedConfig());
  const page = (pathname) => (C.urlPages.find((p) => p.pattern.test(pathname)) || {}).page;
  assert.equal(page("/icpplus/acGrabarCita"), "Booked");
  assert.equal(page("/icpplus/ACINFO"), "Access");
  assert.equal(page("/icpplus/acValidarEntrada"), "Request");
  assert.equal(page("/icpplus/citar"), undefined);
  const known = (txt) => (C.knownMessages.find((m) => m.pattern.test(norm(txt))) || {}).label;
  assert.equal(known("En este momento no hay citas disponibles."), "No appointments available right now");
  assert.equal(known("ERROR 503 Service"), "Site unavailable");
  assert.equal(known("El NIE introducido no es válido"), "Document number rejected");
  assert.equal(known("Todo bien"), undefined);
  assert.ok(C.stepButtons.Access.text.test("ENTRAR"));
  assert.ok(C.stepButtons.Request.text.test("REQUEST AN APPOINTMENT"));
  assert.ok(!C.stepButtons.Request.text.test("SOLICITAR"));
  assert.ok(C.patterns.bookedText.test(norm("Su cita ha sido reservada")));
  assert.ok(C.patterns.tramiteExclude.test("idSede") && !C.patterns.tramiteExclude.test("tramiteGrupo[0]"));
  assert.ok(C.patterns.officePlaceholder.test("SELECCIONE OFICINA"));
  assert.deepEqual(C.officeExcludeValues, ["-1", "0", "99"]);
  assert.deepEqual(C.selectors.next.slice(0, 3), ["#btnAceptar", "#btnEnviar", "#btnSiguiente"]);
});

test("hydrate rejects empty or incomplete configs (content script stays locked)", () => {
  assert.throws(() => CM_SITE.hydrate({}), /no CitaMate page settings/);
  assert.throws(() => CM_SITE.hydrate(null), /no CitaMate page settings/);
  const c = seedConfig();
  delete c.selectors.next;
  c.stepButtons.Access.ids = [];
  assert.throws(() => CM_SITE.hydrate(c), /selectors\.next.*stepButtons\.Access/);
  const bad = seedConfig();
  bad.patterns.bookedText = { source: "(" };
  assert.throws(() => CM_SITE.hydrate(bad), /bad pattern at patterns\.bookedText/);
});

// ---------- catalog seed ----------
test("catalog seed has the four lists the extension uses", () => {
  const cat = JSON.parse(fs.readFileSync(path.join(SEEDS, "citamate-catalog.json"), "utf8"));
  assert.ok(Array.isArray(cat.provinces) && cat.provinces.length > 40);
  assert.ok(Array.isArray(cat.paises) && cat.paises.length > 100);
  assert.ok(cat.tramites && typeof cat.tramites === "object");
  assert.ok(cat.offices && typeof cat.offices === "object");
  const p = cat.provinces.find((x) => x.text === "Barcelona");
  assert.ok(p && Array.isArray(cat.tramites[p.value]) && Array.isArray(cat.offices[p.value]));
});

// ---------- migration ----------
test("pending counts old local data; nothing → null", () => {
  assert.equal(CM_MIGRATE.pending({}), null);
  assert.equal(CM_MIGRATE.pending({ entries: [], logs: [] }), null);
  assert.deepEqual(CM_MIGRATE.pending({ entries: [{}], logs: [{}, {}], officeSightings: [] }), { entries: 1, logs: 2, sightings: 0 });
});

test("planEntries skips entries the server would reject and keeps old ids in order", () => {
  const plan = CM_MIGRATE.planEntries([
    { id: "a", label: "A", docNumber: "x1", fullName: "n" },
    { id: "b", label: "", docNumber: "x2", fullName: "n" },
    { id: "c", label: "C", docNumber: "x3", fullName: "m" },
  ]);
  assert.deepEqual(plan.oldIds, ["a", "c"]);
  assert.equal(plan.items[0].docNumber, "X1");
  assert.ok(!("id" in plan.items[0]));
});

test("idMap + remap point logs and sightings at the new ids", () => {
  const map = CM_MIGRATE.idMap(["a", "c", ""], [{ id: "N1" }, { id: "N2" }, { id: "N3" }]);
  assert.deepEqual(map, { a: "N1", c: "N2" });
  const logs = CM_MIGRATE.remap(
    [
      { id: "l1", t: 5, entryId: "a", entry: "A" },
      { id: "l2", t: 6, entryId: "gone", entry: "Gone" },
      { id: "l3", t: 7, entry: "C" },
      { t: 8, entry: "?" },
    ],
    map,
    { C: "N2" },
  );
  assert.equal(logs[0].entryId, "N1");
  assert.equal(logs[1].entryId, "");
  assert.equal(logs[2].entryId, "N2");
  assert.ok(logs[3].id && logs[3].id.length > 4, "records without an id get one");
  assert.equal(logs[0].id, "l1");
});

test("chunks", () => {
  assert.deepEqual(CM_MIGRATE.chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(CM_MIGRATE.chunks([], 2), []);
});
