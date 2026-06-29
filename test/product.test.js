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

test("parsePrice: formatos US/EU, símbolos y miles vs decimal", () => {
  assert.deepEqual(P.parsePrice("$11.99 USD", "USD"), { amount: 1199, currency: "USD" });
  assert.deepEqual(P.parsePrice("US$ 50", ""), { amount: 5000, currency: "USD" });
  assert.deepEqual(P.parsePrice("€1.234,56", ""), { amount: 123456, currency: "EUR" });
  assert.deepEqual(P.parsePrice("ARS 1.500,00", "ARS"), { amount: 150000, currency: "ARS" });
  assert.deepEqual(P.parsePrice("19", ""), { amount: 1900, currency: "" });
  assert.equal(P.parsePrice("1,500", "USD").amount, 150000); // miles
  assert.equal(P.parsePrice("1,50", "EUR").amount, 150); // decimal
  assert.equal(P.parsePrice("", ""), null);
  assert.equal(P.parsePrice("Sin precio", ""), null);
  assert.equal(P.parsePrice("10", "usd").currency, "USD"); // moneda en mayúscula
});

test("formatMoney: centavos a string con moneda", () => {
  assert.equal(P.formatMoney(1199, "USD"), "11.99 USD");
  assert.equal(P.formatMoney(5000, ""), "50.00");
});

test("appendPriceHistory: agrega al cambiar, no-op si igual, cap 10", () => {
  const p = (a) => ({ amount: a, currency: "USD", url: "u", at: 1 });
  let h = [];
  h = P.appendPriceHistory(h, p(100));
  assert.equal(h.length, 1);
  const same = P.appendPriceHistory(h, p(100));
  assert.equal(same, h); // mismo array (sin cambios)
  h = P.appendPriceHistory(h, p(90));
  assert.equal(h.length, 2);
  for (let i = 0; i < 12; i++) h = P.appendPriceHistory(h, p(i));
  assert.equal(h.length, 10); // truncado
  assert.equal(h[h.length - 1].amount, 11); // el más nuevo
});

test("cheapestSeen: mínimo por moneda, ignora otras, null vacío", () => {
  assert.equal(P.cheapestSeen([]), null);
  const h = [
    { amount: 500, currency: "USD", url: "a" },
    { amount: 200, currency: "EUR", url: "b" }, // otra moneda: se ignora
    { amount: 300, currency: "USD", url: "c" },
  ];
  assert.deepEqual(P.cheapestSeen(h), { amount: 300, currency: "USD", url: "c" });
});
