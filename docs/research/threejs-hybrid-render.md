# Гибридный рендер: CPU-проекция дороги + three.js (валидация и руководство)

Дата: 2026-11-18. Версия three.js: **0.187.0** (`npm view three version` -> 0.187.0, опубликована 2026-10-30; r187). `@types/three` -> 0.187.0. Пиновать точно: `"three": "0.187.0"`, `"@types/three": "0.187.0"` (без `^`). В Migration Guide уже есть раздел 187->188 (dev-ветка) - на 0.187.0 его не применять.

Легенда: [V] проверено по документации/исходникам r187 или официальной вики; [U] не проверено (нужен реальный прогон).

## 0. Вердикт

План жизнеспособен [V по API, U по производительности на реальных телефонах]. Все нужные кирпичи в r187 есть: динамический BufferGeometry, instanced-атрибуты, ShaderMaterial с прямым `gl_Position`, depth buffer, рендер в маленький drawing buffer. Нагрузка крошечная: ~300 сегментов * 3-5 квадов = 1000-3000 треугольников, 2-3 draw call. Узкое место на мобильных - не геометрия, а fillrate перекрывающихся полноширинных квадов и CPU-проекция в JS. При 360x640 fillrate пренебрежим.

Честная оговорка: для такой картинки three.js - тонкая обёртка над WebGL2 (state, program cache, extensions). Оправдано (renderer.info, compile, типы, context-lost), но бандл-оверхед реален. Canvas2D на 360x640 тоже потянул бы ~1000 полигонов; WebGL выигрывает дешёвым апскейлом и fog в шейдере. Решение: остаёмся на three.js, используем только `WebGLRenderer`, `BufferGeometry`, `ShaderMaterial`, `Mesh`, `Texture`/`DataTexture`, `Scene`, `OrthographicCamera` (заглушка). Именованные импорты (`import { ... } from 'three'`).

## 1. Существующие open-source реализации

Честный итог: **хорошей готовой реализации OutRun-стиля на three.js/WebGL не найдено** [два веб-поиска, не исчерпывающе]. Всё популярное - Canvas2D/Phaser. Использовать как источник математики, не архитектуры.

- Code Incomplete "How to build a racing game" (Jake Gordon): https://codeincomplete.com/articles/javascript-racer (v1 straight, v2 curves, v3 hills, v4 final). Canvas2D, сегменты, `project()`, полигон на сегмент, спрайты с clipping по `maxy`. Эталон алгоритма.
- Lou's Pseudo 3D Page: https://www.extentofthejam.com/pseudo/ - математика проекции, холмы, "True 3d-Projected Segments".
- ssusnic/Pseudo-3d-Racer: https://github.com/ssusnic/pseudo-3d-racer - JS-туториал.
- jamessimo/Phaser3-Road: https://github.com/jamessimo/Phaser3-Road - Phaser 3.
- rondras/twin-racer: https://github.com/rondras/twin-racer - Canvas.
- Заметка о порте на сырой WebGL (kodewerx, 2015): https://blog.kodewerx.org/2015/?m=0 - предупреждение о вырождении проекции у горизонта; в нашем CPU-варианте сегменты с `z <= camNear` просто отбрасываются.
- Реальные 3D-гонки на three.js (https://github.com/smarlify/traffic-run-game, форумный "Speedmaxxing") - настоящий 3D-меш трассы, не pseudo-3D; к нашей схеме не применимы.

Как рисуют дорогу: во всех найденных pseudo-3D - **screen-space quads/polygons** (проекция на CPU, заливка трапеций). Подхода "реальный 3D-меш + перспективная камера" в pseudo-3D-проектах нет; он теряет аркадную логику кривых/холмов.

## 2. Рисование CPU-спроецированной геометрии

### 2.1 Выбор: clip-space ShaderMaterial (рекомендация)

Вариант A (рекомендуется): `ShaderMaterial`, вершинный шейдер `gl_Position = vec4(position, 1.0)`; CPU пишет **сразу NDC** (x,y в [-1,1], z в [-1,1]). Камера в математике не участвует; для `renderer.render(scene, camera)` всё равно нужен объект камеры - любой `OrthographicCamera`. Плюсы: нет матриц и ошибок знака, предсказуемая глубина. `w = 1`, значит атрибуты интерполируются линейно в экране (для плоских заливок и fog-по-глубине это правильно; перспективной коррекции текстур нет и не нужно).

Вариант B: `OrthographicCamera(0, W, H, 0, near, far)` в пикселях + стандартные матрицы. z придётся задавать как `-z`; смысла в матрицах нет. Брать только если нужен `MeshBasicMaterial` с `vertexColors` (но тогда fog-ramp по шейдеру из коробки не получится).

Prefix non-Raw `ShaderMaterial` в r187 объявляет `position`, `uv`, `modelViewMatrix`, `projectionMatrix` и т.п. [V WebGLProgram.js] - **не** объявляйте `attribute vec3 position;` повторно. `RawShaderMaterial` не объявляет ничего (нужны `precision`, `in/out`, `glslVersion`).

### 2.2 Глубина (z): сортировка дороги и спрайтов depth-буфером

- NDC z в [-1, 1]; `reversedDepthBuffer` по умолчанию `false` [V]. Всё вне диапазона отсекается.
- `zNdc(i) = -1 + 2 * (i / N)`, i=0 - ближний сегмент, N ~ 300. Монотонно по расстоянию.
- **Дорога/трава/бордюры сегмента i**: плоский z = `zNdc(i)` на всех вершинах квада (нет z-fighting внутри квада; соседи разделены шагом `2/N`). Слои внутри сегмента делать **непересекающимися полосами** (трава, бордюр, полотно, разметка, как отдельные квады с вершинными цветами), без overdraw. Если нужно перекрытие - микрошаг z (`+k*step*0.05`).
- **Спрайт на сегменте i**: `z = zNdc(i) - 0.25 * (2/N)` - чуть ближе своего сегмента, но дальше сегмента i-1. Спрайт закрывает более дальние квады и закрывается более ближними (гребень холма) - без ручной сортировки и без clip-Y. Спрайты между собой сортируются по глубине; с `discard` полупрозрачных пикселей нет, всё корректно.
- **Трава на всю ширину экрана на каждом сегменте** (как в Code Incomplete): тогда depth-тест полностью заменяет классический clip по `maxy`. Иначе спрайт за гребнем виден сквозь "пустоту". Clear color = цвет тумана/неба.
- Точность: depth 24 бит на десктопе, на части мобильных 16 бит - для 300 уровней запас большой [U на реальных устройствах].
- Материал: `depthTest: true, depthWrite: true, transparent: false`. `ShaderMaterial.forceSinglePass` с r151 по умолчанию `true` [V migration guide] - прозрачного двухпроходника нет.
- `renderer.autoClear = true` (дефолт) - depth чистится каждый кадр.

### 2.3 Динамическая геометрия без аллокаций

```ts
import { BufferGeometry, BufferAttribute, DynamicDrawUsage, Mesh } from 'three';

const MAX_QUADS = 300 * 5;                    // сегменты * полос
const pos = new Float32Array(MAX_QUADS * 4 * 3);  // x,y,z в NDC
const col = new Float32Array(MAX_QUADS * 4 * 3);
const idx = new Uint16Array(MAX_QUADS * 6);       // статический, заполнить один раз
for (let q = 0, v = 0, i = 0; q < MAX_QUADS; q++, v += 4, i += 6) {
  idx[i] = v; idx[i + 1] = v + 1; idx[i + 2] = v + 2;
  idx[i + 3] = v; idx[i + 4] = v + 2; idx[i + 5] = v + 3;
}
const geo = new BufferGeometry();
const posAttr = new BufferAttribute(pos, 3).setUsage(DynamicDrawUsage);
const colAttr = new BufferAttribute(col, 3).setUsage(DynamicDrawUsage);
geo.setAttribute('position', posAttr);
geo.setAttribute('aColor', colAttr);
geo.setIndex(new BufferAttribute(idx, 1));
const road = new Mesh(geo, roadMaterial);
road.frustumCulled = false;   // bounding sphere не отражает NDC-данные

// каждый кадр, после заполнения pos/col:
geo.setDrawRange(0, quadCount * 6);          // индексы
for (const a of [posAttr, colAttr]) {
  a.clearUpdateRanges();
  a.addUpdateRange(0, quadCount * 4 * 3);    // start/count в КОМПОНЕНТАХ массива
  a.needsUpdate = true;
}
```

Факты [V r187 src/core/BufferAttribute.js и доки]:
- `BufferAttribute.updateRange` **удалён** (r159). Теперь `updateRanges: {start,count}[]`, `addUpdateRange(start, count)`, `clearUpdateRanges()`; start/count - в элементах typed array, не в вершинах.
- Докстринг: рендерер сам потребляет и сбрасывает диапазоны после загрузки; вызывать `clearUpdateRanges()` перед `addUpdateRange` безвредно и защищает от накопления [U: точная очистка рендерером в 0.187.0 из исходника WebGLAttributes не читалась].
- Без `addUpdateRange` грузится весь массив: ~6000 вершин * 3 float = 72 КБ на буфер - несущественно. Диапазоны использовать, когда пишется малый префикс.
- `setDrawRange` - чистый JS-сеттер, без загрузки [V]. Для индексной геометрии start/count в индексах.
- `Uint16Array` для индекса (до 65535 вершин).
- Никаких `new` в кадре; не пересоздавать атрибуты; размер буфера фиксировать с запасом (изменение размера = пересоздание GL-буфера). `DynamicDrawUsage` ставить до первого рендера.
- Свои имена атрибутов (`aColor`), объявлять в шейдере; встроенный `color` с `ShaderMaterial` не нужен.

### 2.4 Шейдер дороги (fog-ramp по глубине)

```glsl
// vertex
attribute vec3 aColor;
varying vec3 vColor;
varying float vDepth;
void main() {
  vColor = aColor;
  vDepth = position.z * 0.5 + 0.5;       // 0 - близко, 1 - далеко
  gl_Position = vec4(position, 1.0);     // position уже NDC
}
// fragment
uniform vec3 uFogColor; uniform float uFogStart; uniform float uFogEnd;
varying vec3 vColor; varying float vDepth;
void main() {
  float f = smoothstep(uFogStart, uFogEnd, vDepth);
  gl_FragColor = vec4(mix(vColor, uFogColor, f), 1.0);
}
```

Цвета - см. 4.2 (colorSpace).

## 3. InstancedMesh / атлас спрайтов

### 3.1 InstancedMesh или InstancedBufferGeometry

`InstancedMesh` аллоцирует `instanceMatrix` (mat4 на инстанс), нам не нужный. Рекомендуется **`InstancedBufferGeometry` + обычный `Mesh`**: статический квад (4 вершины, 2 треугольника, `aCorner` в [0,1]^2) + `InstancedBufferAttribute` + `geometry.instanceCount = n` каждый кадр. `USE_INSTANCING`/`instanceMatrix` объявляются только для `InstancedMesh` [V WebGLProgram.js], но пользовательские instanced-атрибуты работают в обоих случаях. Если берёте `InstancedMesh`: `mesh.count = n`, `frustumCulled = false`, матрицу не использовать. С r151 `InstancedMesh.frustumCulled` по умолчанию `true` [V] - выключать обязательно.

### 3.2 Атрибуты на инстанс (все `InstancedBufferAttribute`, `DynamicDrawUsage`)

- `iPos` vec3: xNdc центра, yNdc основания, zNdc (см. 2.2).
- `iSize` vec2: ширина/высота в NDC.
- `iUv` vec4: `u0, v0, du, dv` прямоугольник атласа.
- `iTint` vec4 (или Uint8 normalized).
- `iClipY` float (опционально, см. 3.4).
Обновление - как в 2.3.

### 3.3 Минимальный ShaderMaterial

```ts
const spriteMat = new ShaderMaterial({
  uniforms: { uAtlas: { value: atlasTex }, uFogColor: { value: fogRGB }, uFogStart: { value: 0.4 }, uFogEnd: { value: 1.0 } },
  vertexShader: /* glsl */`
    attribute vec2 aCorner;   // (0,0),(1,0),(1,1),(0,1)
    attribute vec3 iPos; attribute vec2 iSize; attribute vec4 iUv; attribute vec4 iTint;
    varying vec2 vUv; varying vec4 vTint; varying float vDepth; varying float vScrY;
    void main() {
      vec2 p = vec2(iPos.x + (aCorner.x - 0.5) * iSize.x, iPos.y + aCorner.y * iSize.y);
      gl_Position = vec4(p, iPos.z, 1.0);
      vUv = iUv.xy + aCorner * iUv.zw;
      vTint = iTint; vDepth = iPos.z * 0.5 + 0.5; vScrY = p.y;
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D uAtlas; uniform vec3 uFogColor; uniform float uFogStart, uFogEnd;
    varying vec2 vUv; varying vec4 vTint; varying float vDepth; varying float vScrY;
    void main() {
      vec4 t = texture2D(uAtlas, vUv);
      if (t.a < 0.5) discard;
      vec3 c = mix(t.rgb * vTint.rgb, uFogColor, smoothstep(uFogStart, uFogEnd, vDepth));
      gl_FragColor = vec4(c, 1.0);
    }`,
  depthTest: true, depthWrite: true, transparent: false,
});
```

- Встроенный `alphaTest` материала работает только если шейдер включает `<alphatest_fragment>`; в самописном шейдере - `discard` вручную (так он и реализован). `discard` отключает early-z на части мобильных GPU; при ~100 спрайтах приемлемо.
- В WebGL2 three.js переводит GLSL ES 1.00 стиль (`attribute/varying/texture2D/gl_FragColor`) через `#define` [V по поведению prefix; U точная форма в 0.187.0]. Если не соберётся - `glslVersion: GLSL3`, `in/out`, `texture()`.
- Атлас: `NearestFilter` (min и mag), `generateMipmaps = false` (с r170 mipmaps генерируются всегда, когда включены - [V migration 169->170] - ставить явно), `ClampToEdgeWrapping`, **padding 1-2 px** между тайлами и UV с отступом в полтексела, иначе протекание соседей. `premultiplyAlpha = false`.

### 3.4 Скрытие спрайтов за гребнем

1. **Depth** (основной, 2.2): при полноширинной траве ничего больше не нужно.
2. **Per-instance clip**: `iClipY` (NDC-Y гребня из CPU-`maxy`), передать varying `vClipY`; во fragment `if (vScrY < vClipY) discard;` (в NDC Y вверх: прячем всё ниже линии клипа). Нужен, если не рисуете траву на всю ширину. Дополнительно можно обрезать высоту/UV на CPU (дешевле по fillrate, сложнее).

## 4. Низкое разрешение и апскейл nearest

### 4.1 Сравнение

| | A: малый drawing buffer + CSS `image-rendering: pixelated` | B: `WebGLRenderTarget` 360x640 + fullscreen quad |
|---|---|---|
| Проходы | 1 | 2 (RT + blit) |
| Fillrate | только 360x640 | 360x640 + полноэкранный blit |
| Память/bandwidth | 1 буфер | RT (цвет+depth) + полноразмерный canvas; на тайловых GPU лишний resolve/store |
| Апскейл | компоситор браузера (GPU) | ваш шейдер, `NearestFilter` |
| Контроль | нецелый коэффициент даёт неровные пиксели | целочисленный масштаб, letterbox, палитра/дизеринг/CRT |

**Рекомендация: A.** Дешевле на мобильных: нет второго прохода и полноэкранной записи (дорого на tile-based GPU). B - только если нужны постэффекты или строго целочисленный масштаб.

```ts
const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, depth: true, stencil: false,
                                     powerPreference: 'high-performance', preserveDrawingBuffer: false });
renderer.setPixelRatio(1);
renderer.setSize(360, 640, false);   // false: CSS не трогать
// CSS: canvas { width:100%; height:100%; image-rendering: pixelated; image-rendering: crisp-edges; touch-action:none; }
// при ресайзе окна менять только CSS/letterbox; внутренний буфер фиксирован
```
(Порядок CSS: сначала `crisp-edges`, потом `pixelated`, чтобы `pixelated` победил там, где поддерживается.)

Факты [V r187 WebGLRenderer.js]: `setPixelRatio` вызывает `setSize(_width,_height,false)` (стиль не меняется); `setSize(w,h,updateStyle=true)`, размер canvas = `floor(w*pixelRatio)`; defaults: `antialias:false`, `alpha:false`, `depth:true`, `stencil:false` (с r163), `powerPreference:'default'`, `preserveDrawingBuffer:false`, `failIfMajorPerformanceCaveat:false`. `powerPreference` на мобильных обычно игнорируется [U]. `image-rendering: pixelated` на iOS Safari/Samsung Internet не тестировалось [U].

Вариант B: `new WebGLRenderTarget(360, 640, { minFilter: NearestFilter, magFilter: NearestFilter, depthBuffer: true })`; `renderer.setRenderTarget(rt); renderer.render(scene, cam); renderer.setRenderTarget(null); renderer.render(blitScene, blitCam);` blit - `PlaneGeometry(2,2)` + ShaderMaterial с `gl_Position = vec4(position.xy, 0., 1.)`. `info.autoReset = false` + ручной `reset()`. С r187 `setViewport()/setScissor()` при привязанном RT **не** умножаются на pixel ratio [V migration 186->187].

### 4.2 colorSpace (r187)

- Дефолты: `renderer.outputColorSpace = SRGBColorSpace`; `ColorManagement.enabled = true`; `Texture.colorSpace = NoColorSpace` [V].
- У **собственного** `ShaderMaterial` автоконвертации в output colorSpace нет: в fragment prefix лишь определена функция `linearToOutputTexel`, вызвать должен шейдер (`#include <colorspace_fragment>`) [V WebGLProgram.js]. Встроенные материалы делают это сами.
- Рендер в RT пишет в working (linear) space без sRGB-кодирования [V WebGLRenderer.setProgram]; tone mapping применяется только при выводе на экран.
- Рекомендация для пиксель-арта: **работать "как в Canvas2D"** - все цвета и атлас в sRGB-значениях без преобразований. Атлас `colorSpace = NoColorSpace` (сэмплер отдаёт байты как есть), цвета пишутся прямо в Float32Array/uniform, `gl_FragColor` идёт прямо в canvas. Не использовать `Color.set*`, не указывая space (он конвертирует sRGB->linear): для чисел брать `new Color().setRGB(r,g,b, SRGBColorSpace)` и затем читать `.r/.g/.b` НЕльзя (там linear) - проще хранить палитру как массив sRGB-чисел.
- Не ставить `texture.colorSpace = SRGBColorSpace`, не добавив `colorspace_fragment`: GPU декодирует в linear при выборке, в canvas уйдёт linear - картинка потемнеет.
- Fog `mix` в sRGB-пространстве физически неточен, но для ретро-стиля ожидаем и дёшев.
- `renderer.toneMapping = NoToneMapping` (дефолт).

## 5. Удалённые/переименованные API (для rules-файла агентов)

Проверено по Migration Guide (https://github.com/mrdoob/three.js/wiki/Migration-Guide) для r150-r188; последние ~15 КБ страницы (очень старые версии r49-r149) не читались, для нас не релевантны. Колонка "Версия" - переход, в котором произошло изменение.

| НЕ писать | Версия | Писать |
|---|---|---|
| `THREE.Geometry`, `Face3`, `geometry.vertices/faces` | удалено r125 | `BufferGeometry` + `BufferAttribute` (старый класс только в `examples/jsm/deprecated/Geometry.js`, не использовать) |
| `renderer.outputEncoding = sRGBEncoding` | r152 | `renderer.outputColorSpace = SRGBColorSpace` (дефолт уже sRGB) |
| `sRGBEncoding`, `LinearEncoding`, `texture.encoding` | r152 | `SRGBColorSpace`, `LinearSRGBColorSpace`, `texture.colorSpace` (дефолт `NoColorSpace`) |
| `ColorManagement.legacyMode = false` | r150 | `ColorManagement.enabled = true` (дефолт true с r152) |
| `ColorManagement.fromWorkingColorSpace / toWorkingColorSpace` | r177 | `workingToColorSpace` / `colorSpaceToWorking` |
| `renderer.physicallyCorrectLights` | r150 | убрано; физический режим по умолчанию |
| `renderer.useLegacyLights` | r155 default false, deprecated | не использовать (интенсивности света в физических единицах) |
| `attr.updateRange = {offset,count}` | r159 | `attr.addUpdateRange(start,count)`, `clearUpdateRanges()`, `attr.updateRanges` |
| `examples/js/*` (глобальные скрипты) | удалено r148 | `three/examples/jsm/...` или `three/addons/...` |
| `build/three.js`, `build/three.min.js` | удалено r161 | ESM: `import ... from 'three'` |
| `WebGLMultipleRenderTargets` | r162 | `new WebGLRenderTarget(w,h,{ count: n })` |
| `WebGLMultisampleRenderTarget` | r138 | `WebGLRenderTarget` с `samples` |
| `WebGLRenderTarget.setTexture()` | r139 | убрано |
| атрибуты `uv2`/`uv3`/`uv4` | r152 | `uv1`/`uv2`/`uv3`; `aoMap`/`lightMap` используют `uv1` с r151 |
| WebGL1 / `WebGL1Renderer` | deprecated r153, не поддерживается r163 | только WebGL2 |
| расчёт на `stencil: true` по умолчанию | r163 | по умолчанию `stencil: false` - задавать явно при нужде |
| `TextGeometry` `height` | r163 | `depth` |
| `CapsuleGeometry` `length` | r176 | `height` |
| `new Clock()` | deprecated r183 | `Timer` (в core с r179); `timer.connect(document)` для visibility; `timer.update(ts)` |
| `RGBELoader` | r180 | `HDRLoader`; `RGBMLoader` удалён |
| `PostProcessing` (WebGPU) | r183 | `RenderPipeline` |
| `MultiplyBlending`/`SubtractiveBlending` без premultipliedAlpha | r178 | требуют `premultipliedAlpha = true` |
| `reverseDepthBuffer`, `USE_LOGDEPTHBUF`, `USE_REVERSEDEPTHBUF` | r179-r180 | `reversedDepthBuffer`, `USE_LOGARITHMIC_DEPTH_BUFFER`, `USE_REVERSED_DEPTH_BUFFER` |
| `PI2` (TSL) | r181 | `TWO_PI` |
| `PCFSoftShadowMap` | deprecated r182 | `PCFShadowMap` / `VSMShadowMap` |
| `Source` | r186 | `TextureSource` |
| WebGPU через `examples/jsm/renderers/webgpu/*` | r171 | `import ... from 'three/webgpu'`, TSL из `three/tsl` |
| `renderAsync`/`computeAsync` и т.п. async-методы WebGPU | deprecated r181 | sync-варианты после `await renderer.init()` (WebGLRenderer.`compileAsync` остаётся) |
| `Object3D` без `dispose` | r186 добавлен `Object3D.dispose()` | при наследовании вызывать `super.dispose()` |

Изменения дефолтов (не удаления, но агенты ошибаются): `InstancedMesh.frustumCulled = true` (r151); `ShaderMaterial.forceSinglePass = true` (r151); `Material.type` статичен (r170); mipmaps всегда генерируются при включённых (r170); `Timer`/`Clock` см. выше.

Общие правила для rules-файла (не из migration guide):
- `geometry/material/texture/renderTarget.dispose()` при удалении.
- Никаких аллокаций (`new Vector3`, `new Float32Array`, литералы массивов/объектов) в горячем цикле.
- Именованные импорты вместо `import * as THREE`.
- Игровая логика на фиксированном шаге с аккумулятором; рендер из `renderer.setAnimationLoop`/rAF.
- Цвет: не смешивать sRGB-хекс и linear числа (см. 4.2).

## 6. renderer.info и прогрев шейдеров

### 6.1 renderer.info [V]

```ts
const r = renderer.info.render;   // { frame, calls, triangles, points, lines }
const m = renderer.info.memory;   // { geometries, textures }
renderer.info.programs?.length;   // число программ
```
- По умолчанию сбрасывается при каждом `renderer.render()` (`info.autoReset = true`). При нескольких проходах (вариант B) - `renderer.info.autoReset = false` и ручной `renderer.info.reset()` после кадра.
- Smoke-бюджет (читать после `render()` на кадре ~120): `calls <= 3`, `triangles <= 4000` (300 сегм. * 5 квадов * 2 = 3000 + ~100 спрайтов * 2), `memory.geometries <= 3`, `memory.textures <= 2`, `programs.length <= 3`. Пороги - рекомендация, не измерение [U].
- Triangles учитывает `drawRange` и `instanceCount` - тест ловит случай, когда рисуется хвост буфера.
- Для CI: `window.__stats = () => ({ ...renderer.info.render, ...renderer.info.memory, programs: renderer.info.programs?.length })`, читать из Playwright.

### 6.2 Прогрев шейдеров [V сигнатуры r187]

- `renderer.compile(scene, camera, targetScene = null)` - синхронно, возвращает `Set<Material>`.
- `renderer.compileAsync(scene, camera, targetScene = null)` - Promise, использует `KHR_parallel_shader_compile`; без расширения - опрос с таймаутом 10 мс. Вызывать на экране загрузки: `await renderer.compileAsync(scene, camera)` до первого игрового кадра. Объекты должны быть в сцене и `visible` (невидимые не компилируются) [U: поведение для visible=false не перепроверялось в r187].
- Программ у нас 2-3, но прогрев убирает фриз первого кадра на слабых Android. Дополнительно - один холостой `render()` с реальным drawRange до старта для первой загрузки буферов и атласа.

## 7. Headless Playwright Chromium на Windows: детерминированные скриншоты

Не проверено на этой машине (Playwright не установлен, скачивание браузера не выполнялось). Всё ниже [U], на основании документации Chromium (SwiftShader) и обсуждений.

- При наличии GPU/драйвера headless Chromium обычно использует ANGLE (D3D11): WebGL2 работает без флагов, но результат зависит от GPU и драйвера (не детерминирован между машинами).
- Для детерминизма - программный SwiftShader:
  ```ts
  chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  ```
  В докe Chromium (docs/gpu/swiftshader.md) WebGL-вариант указан как `--use-angle=swiftshader-webgl` + `--enable-unsafe-swiftshader`; в разных версиях работает одно из значений - проверить на бандл-версии Playwright и оставить то, при котором `getContext('webgl2')` не null.
- Автоматический откат на SwiftShader в Chromium deprecated (Intent to Remove: SwiftShader Fallback); без `--enable-unsafe-swiftshader` WebGL может не создаться без GPU. Флаг убирает консольное предупреждение.
- Подводные камни: `--disable-gpu` не добавлять (по отчётам форсит/ломает выбор бэкенда); чёрный канвас при скриншоте до первого кадра - ждать `window.__ready = true` после первого `render()`; `preserveDrawingBuffer` для `page.screenshot()` не нужен, но нужен для `canvas.toDataURL()` вне того же таска; `viewport {360x640}`, `deviceScaleFactor: 1` (чтобы DPR не плавал); SwiftShader медленный и FPS нестабилен - **не опираться на время rAF**: `window.__step(n)` с фиксированным dt, seeded PRNG, ручной рендер, скриншот после N шагов.
- SwiftShader и GPU могут слегка различаться; сравнивать скриншоты с допуском (`maxDiffPixelRatio` ~0.001) и только в рамках одного режима рендера.
- Гейт теста: `page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))` с понятной ошибкой.

## 8. WebGL vs WebGPURenderer

Рекомендация: **`WebGLRenderer`** (WebGL2). Для CPU-проекции с 2-3 draw call и фиксированным набором шейдеров WebGPU ничего не даёт, а риски реальны: меньший охват мобильных (iOS Safari/старые Android), асинхронная инициализация (`await renderer.init()`), другой шейдерный путь (TSL/WGSL; самописный GLSL `ShaderMaterial` в `WebGPURenderer` не работает, нужен node-материал), нестабильный API (в r171-r187 много переименований), сложнее headless-скриншоты. `WebGPURenderer` умеет откатываться на WebGL2-бэкенд, но тогда это тот же WebGL с лишним слоем и больше бандл. Пересмотреть при появлении compute/тысяч частиц.

## 9. Не проверено

- Производительность на реальных мобильных (fillrate, `discard`, 16-bit depth).
- Очистка `updateRanges` самим рендерером в 0.187.0 (в докстринге только "renderer is responsible").
- Точная форма GLSL-препроцессинга (`texture2D`, `gl_FragColor`) для ShaderMaterial в 0.187.0.
- Флаги Playwright/Chromium (раздел 7) не запускались.
- `image-rendering: pixelated` на iOS Safari и Samsung Internet.
- Поведение `compileAsync` для `visible=false` объектов.
- Последние ~15 КБ Migration Guide (r49-r149) не прочитаны.
- Поиск open-source - два веб-запроса; редкую реализацию на three.js исключить нельзя.
