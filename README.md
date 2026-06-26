# Don't Buy 🛑

Extensión de Chrome (Manifest V3) que te ayuda a **frenar las compras
impulsivas**. Cuando estás viendo la ficha de un producto, te avisa con un
banner y te pregunta si realmente lo necesitás. Tu decisión se guarda y se
**sincroniza entre todos los navegadores con tu misma cuenta de Google**.

## Cómo funciona

1. Un *content script* corre en cada página y detecta si estás viendo un
   producto. Primero aplica **reglas a medida para Amazon, eBay y
   MercadoLibre** (más fiables); si no estás en una de esas tiendas, cae a
   detección genérica con marcado estándar (JSON-LD `schema.org/Product`,
   OpenGraph, microdata, y como respaldo precio + botón de compra).
2. Compara el producto contra tus listas:
   - **No está marcado** → banner suave: *"¿Seguro que lo necesitás?"*
   - **Ya dijiste que no lo necesitás** (mismo producto o misma familia) →
     banner reforzado.
   - **Dijiste que sí lo necesitás** → no molesta.
3. Respondés en el banner:
   - **"Lo necesito"** → se agrega a tu *allowlist* (no vuelve a avisar).
   - **"No lo necesito"** → se agrega a tu *blocklist* sincronizada.
   - Casilla **"Aplicar a toda la familia"** para cubrir productos similares
     (misma categoría o título parecido), no solo ese producto exacto.

Todo se guarda en `chrome.storage.sync`, así que aparece en cualquier Chrome
donde inicies sesión con la misma cuenta. Sin servidor propio, sin login extra.

## Instalación (modo desarrollador)

1. Abrí `chrome://extensions`.
2. Activá **Modo de desarrollador** (arriba a la derecha).
3. **Cargar descomprimida** → elegí esta carpeta (`dont-buy-chrome-extension`).
4. Listo. El icono 🛑 aparece en la barra; el número del badge es cuántos
   productos marcaste como innecesarios.

## Uso

- **Popup** (click en el icono): activar/desactivar avisos y ver contadores.
- **Opciones** (botón "Gestionar mis listas"): ver, borrar o vaciar tus listas.

## Estructura

```
manifest.json                 Configuración MV3
src/lib/product.js            Lógica pura: normalización, claves, matching de familias
src/lib/storage.js            Acceso a chrome.storage.sync (solo service worker)
src/content/sites.js          Reglas a medida: Amazon, eBay, MercadoLibre
src/content/detector.js       Detección genérica + extracción de firma
src/content/banner.js         Banner del aviso (Shadow DOM)
src/content/matcher.js        Orquestación del content script
src/background/service-worker.js  Mensajería + persistencia + badge
src/popup/                    Popup de la barra
src/options/                  Página de gestión de listas
icons/                        Iconos 16/48/128
test/product.test.js          Tests de la lógica pura
```

## Tests

```bash
npm test     # o: node --test
```

Cubren la lógica pura de `src/lib/product.js` (normalización, generación de
claves, matching por familia y la resolución allow/block/unknown).

## Limitaciones conocidas

- **Móvil**: Chrome para Android no soporta extensiones, así que esto solo
  funciona en escritorio. (Navegadores como Kiwi/Edge mobile podrían ser una
  alternativa futura.)
- Hay selectores a medida para **Amazon, eBay y MercadoLibre**; el resto de
  las tiendas usa detección heurística, que puede no reconocer marcado muy
  poco estándar o disparar en páginas que no son fichas de producto. Para
  sumar otra tienda, agregá una regla en `src/content/sites.js`.

## Próximos pasos (fuera del MVP)

- Clasificación de familias con IA (opcional, requiere API key y decisión de
  privacidad).
- Backend propio con cuentas para capacidad ilimitada o compartir entre
  usuarios.
- Estadísticas de "frenos" / dinero evitado.
