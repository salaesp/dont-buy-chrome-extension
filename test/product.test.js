/*
 * Tests de la lógica pura (src/lib/product.js). Sin dependencias externas:
 * usa el runner integrado de Node.
 *   node --test
 */
const { test } = require("node:test");
const assert = require("node:assert");
const P = require("../src/lib/product.js");

test("normalizeText: minúsculas, sin acentos, sin signos", () => {
  assert.equal(P.normalizeText("Zapatillas Running Niké!"), "zapatillas running nike");
  assert.equal(P.normalizeText("  Café   ÉPICO  "), "cafe epico");
});

test("tokenize: saca stopwords y palabras cortas", () => {
  assert.deepEqual(P.tokenize("Auriculares de la marca Sony"), [
    "auriculares",
    "marca",
    "sony",
  ]);
});

test("makeKey: estable e independiente de mayúsculas/acentos", () => {
  const a = P.makeKey("Amazon.com", "Café Molido");
  const b = P.makeKey("amazon.com", "cafe molido");
  assert.equal(a, b);
});

test("buildSignature: arma firma con tokens y categoría normalizada", () => {
  const sig = P.buildSignature({
    domain: "tienda.com",
    title: "Auriculares Bluetooth Sony WH-1000",
    category: "Audio / Auriculares",
    priceText: "199",
    currency: "USD",
  });
  assert.ok(sig.key);
  assert.equal(sig.categoryNorm, "audio auriculares");
  assert.ok(sig.tokens.includes("auriculares"));
});

test("isFamilyMatch: misma categoría => true", () => {
  const sig = P.buildSignature({ title: "Producto A", category: "Zapatillas" });
  const entry = P.buildSignature({ title: "Producto B", category: "Zapatillas" });
  assert.equal(P.isFamilyMatch(sig, entry), true);
});

test("isFamilyMatch: títulos similares sin categoría => true", () => {
  const sig = P.buildSignature({ title: "Auriculares Bluetooth Sony" });
  const entry = P.buildSignature({ title: "Auriculares Bluetooth Philips" });
  assert.equal(P.isFamilyMatch(sig, entry), true);
});

test("isFamilyMatch: productos distintos => false", () => {
  const sig = P.buildSignature({ title: "Licuadora de cocina" });
  const entry = P.buildSignature({ title: "Zapatillas running trail" });
  assert.equal(P.isFamilyMatch(sig, entry), false);
});

test("evaluate: allowlist exacta gana sobre blocklist", () => {
  const sig = P.buildSignature({ domain: "x.com", title: "Mouse Gamer" });
  const entry = { ...sig, scope: "product" };
  const verdict = P.evaluate(sig, {
    blocklist: [entry],
    allowlist: [entry],
  });
  assert.equal(verdict.status, "allow");
});

test("evaluate: producto en blocklist => block", () => {
  const sig = P.buildSignature({ domain: "x.com", title: "Mouse Gamer RGB" });
  const verdict = P.evaluate(sig, { blocklist: [sig], allowlist: [] });
  assert.equal(verdict.status, "block");
  assert.equal(verdict.reason, "product");
});

test("evaluate: familia en blocklist => block por familia", () => {
  const seen = P.buildSignature({ title: "Auriculares Sony", category: "Audio" });
  const nuevo = P.buildSignature({ title: "Auriculares Philips", category: "Audio" });
  const verdict = P.evaluate(nuevo, { blocklist: [seen], allowlist: [] });
  assert.equal(verdict.status, "block");
  assert.equal(verdict.reason, "family");
});

test("evaluate: allowlist por familia evita el aviso", () => {
  const allowed = P.buildSignature({ title: "Auriculares Sony", category: "Audio" });
  allowed.scope = "family";
  const nuevo = P.buildSignature({ title: "Auriculares Philips", category: "Audio" });
  const verdict = P.evaluate(nuevo, {
    blocklist: [P.buildSignature({ title: "Auriculares JBL", category: "Audio" })],
    allowlist: [allowed],
  });
  assert.equal(verdict.status, "allow");
});

test("evaluate: producto desconocido => unknown", () => {
  const sig = P.buildSignature({ title: "Lámpara de escritorio LED" });
  const verdict = P.evaluate(sig, { blocklist: [], allowlist: [] });
  assert.equal(verdict.status, "unknown");
});

test("scoreMatch: mismo producto => 1", () => {
  const a = P.buildSignature({ domain: "x.com", title: "Mouse Gamer RGB" });
  assert.equal(P.scoreMatch(a, a), 1);
});

test("scoreMatch: misma categoría => al menos 0.6", () => {
  const a = P.buildSignature({ title: "Auriculares Sony", category: "Audio" });
  const b = P.buildSignature({ title: "Parlante JBL", category: "Audio" });
  assert.ok(P.scoreMatch(a, b) >= 0.6);
});

test("evaluate: block por familia elige el MÁS parecido y trae score", () => {
  const lejano = P.buildSignature({ title: "Auriculares JBL inalámbricos" });
  const cercano = P.buildSignature({ title: "Auriculares Sony Bluetooth WH" });
  const nuevo = P.buildSignature({ title: "Auriculares Sony Bluetooth WH 1000" });
  const verdict = P.evaluate(nuevo, { blocklist: [lejano, cercano], allowlist: [] });
  assert.equal(verdict.status, "block");
  assert.equal(verdict.reason, "family");
  assert.equal(verdict.match.title, cercano.title); // el más parecido
  assert.ok(verdict.score > 0 && verdict.score <= 1);
});

test("normalizeHost: saca www, esquema y path", () => {
  assert.equal(P.normalizeHost("https://www.Amazon.com/dp/x"), "amazon.com");
  assert.equal(P.normalizeHost("MercadoLibre.com.ar"), "mercadolibre.com.ar");
});

test("hostMatches: lista blanca por dominio/subdominio/trozo", () => {
  const hosts = ["amazon.", "repebble.com"];
  assert.equal(P.hostMatches("www.amazon.com.ar", hosts), true);
  assert.equal(P.hostMatches("repebble.com", hosts), true);
  assert.equal(P.hostMatches("listado.mercadolibre.com.ar", hosts), false);
  assert.equal(P.hostMatches("google.com", hosts), false);
});

test("hostMatches: lista vacía => no corre en ningún lado", () => {
  assert.equal(P.hostMatches("amazon.com", []), false);
});
