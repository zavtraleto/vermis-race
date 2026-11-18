# javascript-racer (Jake Gordon) — заметки для реализации pseudo-3D дороги

Источник: https://github.com/jakesgordon/javascript-racer (ветка master).
Прочитано целиком, из raw.githubusercontent.com: `v1.straight.html`, `v2.curves.html`, `v3.hills.html`, `v4.final.html`, `common.js`.
Статьи Jake Gordon (v1-straight, v2-curves, v3-hills, v4-final) и Lou's Pseudo 3d Page (extentofthejam.com/pseudo) прочитаны как текст; блоки `<pre>` с кодом в статьях при конвертации в текст пропали, поэтому весь код ниже взят из исходников, а не из статей.
Не читались: `common.css`, `stats.js`, картинки спрайтов/фона (нерелевантно).
Все числа ниже — из кода; производные значения помечены "(расчёт)", мои выводы — "ВЫВОД".
Фрагменты кода ниже — (c) Jake Gordon, javascript-racer, цитаты короткие, для справки.

---

## 1. Проекция и константы

Константы (v4.final.html; v1–v3 те же там, где присутствуют):

| имя | значение | смысл |
|---|---|---|
| fps / step | 60 / 1/60 | фиксированный шаг update |
| width x height | 1024 x 768 (логич.) | resolution = height/480 |
| roadWidth | 2000 | ПОЛОВИНА ширины дороги: дорога от -roadWidth до +roadWidth |
| segmentLength | 200 | длина сегмента по z (мировые единицы) |
| rumbleLength | 3 | сегментов в одной полосе бордюра (`floor(n/rumbleLength)%2` выбирает LIGHT/DARK) |
| lanes | 3 | количество полос |
| fieldOfView | 100 | градусов |
| cameraHeight | 1000 | высота камеры над дорогой |
| cameraDepth | `1/tan((fov/2)*PI/180)` = 0.8391 (расчёт) | расстояние до плоскости проекции |
| playerZ | `cameraHeight * cameraDepth` = 839.1 (расчёт) | z машины игрока относительно камеры |
| drawDistance | 300 | сегментов (= 60000 ед., расчёт) |
| fogDensity | 5 | |

Диапазоны ползунков tweak UI: roadWidth 500..3000, cameraHeight 500..5000, drawDistance 100..500, fieldOfView 80..140, fogDensity 0..50.

Проекция (common.js, Util.project):

```js
p.camera.x     = (p.world.x || 0) - cameraX;
p.camera.y     = (p.world.y || 0) - cameraY;
p.camera.z     = (p.world.z || 0) - cameraZ;
p.screen.scale = cameraDepth/p.camera.z;
p.screen.x     = Math.round((width/2)  + (p.screen.scale * p.camera.x  * width/2));
p.screen.y     = Math.round((height/2) - (p.screen.scale * p.camera.y  * height/2));
p.screen.w     = Math.round(             (p.screen.scale * roadWidth   * width/2));
```

Вызов (v4 render):

```js
Util.project(segment.p1, (playerX * roadWidth) - x,      playerY + cameraHeight, position - (segment.looped ? trackLength : 0), cameraDepth, width, height, roadWidth);
Util.project(segment.p2, (playerX * roadWidth) - x - dx, playerY + cameraHeight, ...тот же z..., cameraDepth, width, height, roadWidth);
```

Наблюдения:
- Каждый сегмент хранит две точки: `p1` — центр ближнего ребра, `p2` — центр дальнего (world.z = n*segLen и (n+1)*segLen). Ширина дороги не хранится в мире, это всегда `±roadWidth`, проецируется как `screen.w`.
- `cameraY = playerY + cameraHeight`: камера едет на высоте интерполированной Y сегмента под игроком (v3/v4). Горизонт при этом остаётся на `height/2` (z -> inf даёт screen.y -> height/2); высота холмов видна только через дорогу и смещение фона.
- `playerZ = cameraHeight*cameraDepth`: на плоской дороге `scale = cameraDepth/playerZ = 1/cameraHeight`, и точка дороги под машиной проецируется ровно в `y = height` (низ экрана) (расчёт). Поэтому машина в v1/v2 рисуется с `destY = height`.
- Отсечение "за камерой": `segment.p1.camera.z <= cameraDepth` (не по playerZ).
- Статья v1 называет FOV "вертикальным", но в коде x масштабируется на `width/2`, y на `height/2`: проекция не изотропная (неквадратные "пиксели" при width != height). Спрайты же масштабируются через `width/2` и по w, и по h. ВЫВОД: для портрета это надо решить явно, см. раздел 7.
- Lou: `scaling = (x_resolution/2) / tan(fov_angle/2)` — совпадает с `cameraDepth * width/2`.
- Зацикливание: `findSegment(z) = segments[Math.floor(z/segmentLength) % segments.length]`; `segment.looped = segment.index < baseSegment.index`, тогда z сегмента сдвигается на `-trackLength`. Позиция заворачивается через `Util.increase(start, inc, max)` (while-циклы).
- Зачем отдельный `rumbleLength`: мелкие сегменты для плавных кривых/холмов, но длинные полосы бордюра, иначе стробирование цвета (статья v1).
- Render.segment: трава — `fillRect` на всю ширину между y2..y1; бордюр `rumbleWidth = w/max(6, 2*lanes)`; метка полосы `laneMarkerWidth = w/max(32, 8*lanes)`; разметка только у `COLORS.LIGHT` (у DARK поля `lane` нет, отсюда пунктир).
- Цвета: SKY `#72D7EE`, FOG/TREE `#005108`, LIGHT {road #6B6B6B, grass #10AA10, rumble #555555, lane #CCCCCC}, DARK {road #696969, grass #009A00, rumble #BBBBBB}.

## 2. Кривые

Хранится только `segment.curve` (скаляр: + вправо, - влево). X-координат в мире нет (статья v2: "we wont be calculating x coordinates for our road segments at all"). Идея Lou: смещать центр-линию.

Render-цикл (v2/v3/v4):

```js
var baseSegment = findSegment(position);
var basePercent = Util.percentRemaining(position, segmentLength);   // (position % segLen)/segLen
var x  = 0;
var dx = - (baseSegment.curve * basePercent);                       // дробная коррекция

for (n = 0; n < drawDistance; n++) {
  segment = segments[(baseSegment.index + n) % segments.length];
  Util.project(segment.p1, (playerX*roadWidth) - x,      ...);
  Util.project(segment.p2, (playerX*roadWidth) - x - dx, ...);
  x  = x + dx;
  dx = dx + segment.curve;
  ...
}
```

Смысл:
- `x` — накопленное смещение камеры по X, `dx` — скорость его изменения; смещение n-го сегмента — арифметическая прогрессия (Lou: сумма N(N+1)/2 * A). Автор в статье v2 сам засомневался, нужны ли оба аккумулятора, затем (по комментарию PeteB) признал: кривая — 2-й порядок, оба нужны.
- `p1` сдвигается на `x`, `p2` на `x + dx`; затем `x += dx; dx += curve`.
- Знак: в проекции `camera.x = world.x - cameraX`, `cameraX = playerX*roadWidth - x`, значит `camera.x = x - playerX*roadWidth` (для world.x = 0). При curve > 0 x растёт, дальние сегменты уходят на экране вправо (расчёт по коду). Согласуется с центробежкой: curve > 0 сносит игрока влево.
- basePercent-коррекция (против дрожания на границе сегмента): `dx` стартует с `-baseSegment.curve * basePercent`. Lou цитирует Jake и формулирует `dx = -percentage_of_segment_traversed * ddx`: X дороги становится функцией Z, форма кривой не меняется при прокрутке, ближний сегмент "втягивается" на место. Простой сдвиг дороги по x (как интерполяция x спрайтов) не решает проблему: дальние полигоны остаются не выровнены (Lou). Без поправки кривая "прыгает" на каждой границе сегмента.
- ВЫВОД: в three.js та же схема считается на CPU и пишется в вершины; нужна та же `position % segmentLength` поправка.

addRoad (enter / hold / leave, v2):

```js
function addRoad(enter, hold, leave, curve) {
  for(n = 0; n < enter; n++) addSegment(Util.easeIn(0, curve, n/enter));
  for(n = 0; n < hold;  n++) addSegment(curve);
  for(n = 0; n < leave; n++) addSegment(Util.easeInOut(curve, 0, n/leave));
}
```

Easing (common.js):

```js
easeIn:    a + (b-a)*Math.pow(percent,2)
easeOut:   a + (b-a)*(1-Math.pow(1-percent,2))
easeInOut: a + (b-a)*((-Math.cos(percent*Math.PI)/2) + 0.5)
```
Фазы enter/leave идут по `n/enter`, `n/leave` (1.0 не достигается; leave стартует ровно с `curve`).

Таблицы:

```js
ROAD = {
  LENGTH: { NONE: 0, SHORT: 25, MEDIUM: 50, LONG: 100 },   // сегментов на КАЖДУЮ из 3 фаз
  HILL:   { NONE: 0, LOW: 20, MEDIUM: 40, HIGH: 60 },       // высота в сегментах (умножается на segmentLength)
  CURVE:  { NONE: 0, EASY: 2, MEDIUM: 4, HARD: 6 }
};
```
(v2 содержит только LENGTH и CURVE; HILL с v3.) `addStraight/addHill/addCurve` вызывают `addRoad(num, num, num, curve, height)`: итоговая длина = 3*num. Пример: `addCurve(LONG, MEDIUM)` = 300 сегментов = 60000 ед.
Есть `addSCurves` (5 стыкованных addRoad MEDIUM: -EASY, +MEDIUM, +EASY, -EASY, -MEDIUM), `addLowRollingHills`, `addBumps`, `addDownhillToEnd`.

Единицы кривизны (расчёт): боковое смещение дальней точки растёт как curve * N^2/2: curve 4 за 100 сегментов = 20000 ед. = 10 half-roadWidth. Автор: значения "somewhat arbitrary", подобраны методом проб; они зависят от segmentLength, roadWidth и drawDistance вместе.

Lou дополнительно (не в коде Jake): трюк Foppygames — умножать dx на z линии, чтобы кривая была резче вдали.

## 3. Модель игрока

Скорости в мировых z-единицах в секунду; `position += dt*speed`.

```js
maxSpeed     = segmentLength/step;   // 200*60 = 12000  (не больше 1 сегмента за кадр -> проще коллизии)
accel        =  maxSpeed/5;          //  2400
breaking     = -maxSpeed;            // -12000
decel        = -maxSpeed/5;          // -2400
offRoadDecel = -maxSpeed/2;          // -6000
offRoadLimit =  maxSpeed/4;          //  3000
centrifugal  = 0.3;
```
Ловушка v4: `offRoadDecel` объявлена в v4 дважды: сначала `var offRoadDecel = 0.99; // speed multiplier when off road`, потом `-maxSpeed/2`. Действует вторая; комментарий про 0.99 — мусор. В v1–v3 она объявлена один раз (-maxSpeed/2).

Update (v4):

```js
var speedPercent = speed/maxSpeed;
var dx = dt * 2 * speedPercent;   // на макс. скорости пересечь -1..1 за 1 секунду
position = Util.increase(position, dt * speed, trackLength);
if (keyLeft) playerX -= dx; else if (keyRight) playerX += dx;
playerX = playerX - (dx * speedPercent * playerSegment.curve * centrifugal);
if (keyFaster) speed = Util.accelerate(speed, accel, dt);
else if (keySlower) speed = Util.accelerate(speed, breaking, dt);
else speed = Util.accelerate(speed, decel, dt);
if ((playerX < -1 || playerX > 1) && speed > offRoadLimit)
  speed = Util.accelerate(speed, offRoadDecel, dt);
playerX = Util.limit(playerX, -3, 3);      // v1-v3: -2..2
speed   = Util.limit(speed, 0, maxSpeed);
```
(`Util.accelerate(v, a, dt) = v + a*dt`.)

- `playerX` нормирован: -1..+1 = края дороги (не зависит от roadWidth); камера использует `playerX*roadWidth`.
- Боковая скорость пропорциональна speedPercent (на месте не рулится).
- Центробежка: `dx*speedPercent*curve*0.3` — пропорциональна квадрату скорости (dx уже содержит speedPercent). Расчёт: curve 4 на макс. скорости = 0.04/кадр = 2.4 playerX/сек; curve 2 — 1.2/сек. `playerSegment = findSegment(position + playerZ)`.
- Off-road: замедление только пока `speed > offRoadLimit` — нельзя стоять на траве (минимум 3000 = 25% макс.).
- HUD speed: `5 * Math.round(speed/500)` (косметика).
- Холмы на игрока не влияют (статья v3).
- Порядок в update v4: `updateCars` -> position -> playerX -> speed -> off-road -> коллизии со спрайтами и машинами -> клэмпы -> фон.
- Игровой цикл (common.js): аккумулятор `gdt`, `dt = min(1, (now-last)/1000)`, `while (gdt > step) update(step)`, затем один `render()`.

## 4. Холмы

Мир: `p1.world.y` сегмента = `p2.world.y` предыдущего (`lastY()`), `p2.world.y` задаётся. Рендер не менялся (проекция уже 3D по y); автор: "add a y component ... and render() will just magically work".

addRoad с y (v3/v4):

```js
var startY = lastY();
var endY   = startY + (Util.toInt(y, 0) * segmentLength);
var total  = enter + hold + leave;
for(n=0;n<enter;n++) addSegment(Util.easeIn(0, curve, n/enter),     Util.easeInOut(startY, endY, n/total));
for(n=0;n<hold; n++) addSegment(curve,                              Util.easeInOut(startY, endY, (enter+n)/total));
for(n=0;n<leave;n++) addSegment(Util.easeInOut(curve, 0, n/leave),  Util.easeInOut(startY, endY, (enter+hold+n)/total));
```
Высота холма = `y * segmentLength` (HIGH 60 -> 12000 ед.); профиль по y — один easeInOut на всю длину (enter+hold+leave), а не по фазам. `addDownhillToEnd` возвращает y к 0 (`-lastY()/segmentLength`), замыкая трек по высоте. Профиль `addBumps`: 10/10/10 сегментов, высоты 5,-2,-5,8,5,-7,5,-2.

Y игрока (render):

```js
var playerSegment = findSegment(position+playerZ);
var playerPercent = Util.percentRemaining(position+playerZ, segmentLength);
var playerY       = Util.interpolate(playerSegment.p1.world.y, playerSegment.p2.world.y, playerPercent);
// cameraY = playerY + cameraHeight
```

Клиппинг сегментов за гребнем (front-to-back, `maxy` = верхняя граница уже закрашенной области, старт `height`):

```js
if ((segment.p1.camera.z <= cameraDepth)         || // behind us
    (segment.p2.screen.y >= segment.p1.screen.y) || // back face cull
    (segment.p2.screen.y >= maxy))                  // clip by (already rendered) hill
  continue;
...
maxy = segment.p1.screen.y;   // v4
```
Расхождение версий: в v1–v3 после отрисовки `maxy = segment.p2.screen.y`; в v4 `maxy = segment.p1.screen.y`. Back-face cull (`p2.y >= p1.y`) добавлен в v3. Идея (статья v4): painter's algorithm back-to-front тратит время на перекрытое; поэтому дорога идёт front-to-back с отсечением скрытого. Lou: "a 3d segment whose screen_y is projected as lower than the last-drawn would not be shown (however, its sprites may still be visible)".

Спрайты за гребнем: на фазе 1 для каждого сегмента пишется `segment.clip = maxy` ДО отрисовки этого сегмента, т.е. clip = верх уже нарисованной ближней геометрии. На фазе 2 спрайты клиппятся по нему:

```js
// Render.sprite
var clipH = clipY ? Math.max(0, destY+destH-clipY) : 0;
if (clipH < destH)
  ctx.drawImage(sprites, sprite.x, sprite.y, sprite.w, sprite.h - (sprite.h*clipH/destH), destX, destY, destW, destH - clipH);
```
Обрезается НИЗ спрайта (часть под линией гребня), верх остаётся виден над холмом. `fog`, `clip` и проекция считаются до `continue`, поэтому у пропущенного сегмента спрайты всё равно рисуются.

Фон по Y: `Render.background(..., offset = resolution * layerSpeed * playerY)` — простое смещение по playerY; автор признаёт, что правильнее учитывать наклон. Lou: на подъёме горизонт опускается относительно верха дороги, на спуске поднимается.

Y машины игрока на экране (v3/v4): `(height/2) - (cameraDepth/playerZ * interpolate(p1.camera.y, p2.camera.y, playerPercent) * height/2)`; спрайт игрока выбирается по знаку `p2.world.y - p1.world.y` (uphill) и по `steer`.

## 5. Спрайты и машины

Масштаб (Render.sprite):

```js
var destW = (sprite.w * scale * width/2) * (SPRITES.SCALE * roadWidth);
var destH = (sprite.h * scale * width/2) * (SPRITES.SCALE * roadWidth);
destX = destX + (destW * (offsetX || 0));
destY = destY + (destH * (offsetY || 0));
```
`SPRITES.SCALE = 0.3 * (1/SPRITES.PLAYER_STRAIGHT.w)` = 0.00375 (расчёт): опорный спрайт игрока 80 px = 0.3 half-roadWidth (600 ед. при roadWidth 2000, т.е. 15% полной ширины дороги). `scale` = `screen.scale` сегмента (`cameraDepth/camera.z`); для игрока `cameraDepth/playerZ`.

Соглашение offset: `-1` = левый край дороги, `+1` = правый, за пределами — обочина (деревья/кусты 1.5..~3.5 и 2..7, billboards ±1.2, колонны 1.1). Позиция: `spriteX = p1.screen.x + (scale * offset * roadWidth * width/2)`. Якорь: `offsetX = (offset < 0 ? -1 : 0)` (левые растут влево от точки, правые вправо, не заходят на дорогу), `offsetY = -1` (низ спрайта на дороге). Машины: `offsetX = -0.5` (центр), `offsetY = -1`.

Порядок отрисовки: фаза 1 дорога front-to-back (n = 0..drawDistance-1); фаза 2 спрайты back-to-front `for (n = drawDistance-1; n > 0; n--)`; внутри сегмента: машины, затем roadside-спрайты, затем игрок (`segment == playerSegment`). Цикл `n > 0` пропускает самый ближний сегмент. Roadside-спрайт использует `p1.screen.scale/x/y` сегмента (без интерполяции), машины интерполируются: `car.percent = percentRemaining(car.z, segmentLength)`, `scale/x/y = interpolate(p1, p2, car.percent)`.

Машины: `{offset, z, sprite, speed}`; хранятся и в общем `cars` (update), и в `segment.cars` (render, коллизии; при смене сегмента перекладываются splice/push). 200 машин; старт `offset = random * ±0.8`, `speed = maxSpeed/4 + random * maxSpeed/(SEMI ? 4 : 2)` (3000..9000, SEMI 3000..6000, расчёт). По кривым машины не рулят: кривые фиктивны, достаточно двигать z (статья v4).

AI (updateCarOffset, v4):

```js
lookahead = 20; carW = car.sprite.w * SPRITES.SCALE;
if ((carSegment.index - playerSegment.index) > drawDistance) return 0;   // вне видимости не рулим
for (i = 1; i < lookahead; i++) {
  segment = segments[(carSegment.index+i) % segments.length];
  if (segment === playerSegment && car.speed > speed && Util.overlap(playerX, playerW, car.offset, carW, 1.2)) {
    if (playerX > 0.5) dir = -1; else if (playerX < -0.5) dir = 1; else dir = (car.offset > playerX) ? 1 : -1;
    return dir * 1/i * (car.speed-speed)/maxSpeed;
  }
  for (j...) { otherCar...; if (car.speed > otherCar.speed && Util.overlap(car.offset, carW, otherCar.offset, otherCarW, 1.2)) { ...та же логика dir...; return dir * 1/i * (car.speed-otherCar.speed)/maxSpeed; } }
}
if (car.offset < -0.9) return 0.1; else if (car.offset > 0.9) return -0.1; else return 0;
```
Возвращаемое значение — приращение `car.offset` ЗА КАДР update (dt не участвует), тем больше, чем ближе препятствие (1/i) и больше разница скоростей; возврат на дорогу +-0.1 за кадр. Рулит только быстрая машина, догоняющая медленную. Автор: в плотном трафике машины дёргаются влево-вправо (rubberbanding), предлагает давать им замедляться.

Overlap (common.js):

```js
overlap(x1, w1, x2, w2, percent) { half = (percent||1)/2; min1 = x1-w1*half; max1 = x1+w1*half; min2 = x2-w2*half; max2 = x2+w2*half; return !((max1 < min2) || (min1 > max2)); }
```
Ширины в нормированных единицах: `w = sprite.w * SPRITES.SCALE` (игрок 0.3). Только по X; по Z "пересечение" = нахождение в одном сегменте (200 ед.).

Коллизия с машиной (только `playerSegment.cars`):

```js
if (speed > car.speed && Util.overlap(playerX, playerW, car.offset, carW, 0.8)) {
  speed    = car.speed * (car.speed/speed);                 // сильно ниже скорости машины
  position = Util.increase(car.z, -playerZ, trackLength);   // откат назад, за бампер
}
```

Коллизия с roadside-спрайтом (только при `|playerX| > 1`, т.е. вне дороги):

```js
if (Util.overlap(playerX, playerW, sprite.offset + spriteW/2 * (sprite.offset > 0 ? 1 : -1), spriteW)) {
  speed = maxSpeed/5;                                                          // 2400
  position = Util.increase(playerSegment.p1.world.z, -playerZ, trackLength);   // в начало сегмента
}
```
Центр хитбокса = якорь +- половина ширины (совпадает с якорем отрисовки). Автор: игрока не останавливают полностью, чтобы можно было "соскользнуть" вбок (хак).

## 6. Туман и параллакс-фон

Туман (common.js):

```js
exponentialFog: function(distance, density) { return 1 / (Math.pow(Math.E, (distance * distance * density))); }
// segment.fog = Util.exponentialFog(n/drawDistance, fogDensity);
// Render.fog: if (fog < 1) { ctx.globalAlpha = (1-fog); ctx.fillStyle = COLORS.FOG; ctx.fillRect(x, y, width, height); }
```
`fog` — ВИДИМОСТЬ (1 вблизи, e^-5 = 0.0067 на дальней границе при density 5, расчёт); альфа заливки = `1-fog`. Аргумент — не мировое расстояние, а индекс сегмента `n/drawDistance`. Каждый сегмент заливается цветом тумана (`#005108`) полосой y1..y2 на всю ширину. Спрайты туманом НЕ затеняются (fog только в Render.segment). ВЫВОД: в three.js — vertex color/uniform на сегмент или fog в шейдере по `n/drawDistance`; для спрайтов добавить вручную.

Фон: 3 слоя (SKY, HILLS, TREES), картинка слоя 1280x480, видимое окно `layer.w/2` = 640 px; окно скроллится и заворачивается:

```js
// update v4 (в v2/v3 вместо (position-startPosition)/segmentLength стоит speedPercent)
skyOffset  = Util.increase(skyOffset,  skySpeed  * playerSegment.curve * (position-startPosition)/segmentLength, 1);
hillOffset = Util.increase(hillOffset, hillSpeed * playerSegment.curve * (position-startPosition)/segmentLength, 1);
treeOffset = Util.increase(treeOffset, treeSpeed * playerSegment.curve * (position-startPosition)/segmentLength, 1);
// skySpeed = 0.001, hillSpeed = 0.002, treeSpeed = 0.003
```
- Offset — доля ширины слоя 0..1, зациклен (`Util.increase(..., 1)`). Приращение = `layerSpeed * curve_сегмента_под_игроком * пройденная_длина/segmentLength`. Параллакс = множители 1:2:3. v4 привязывает к пройденному пути (одинаково при любом dt), v2/v3 — к speedPercent за update.
- Рендер (Render.background): `sourceX = layer.x + floor(layer.w * rotation)`; при выходе за край дорисовывается хвост с начала слоя вторым drawImage (`destW-1` против шва).
- Вертикаль: `offset = resolution * layerSpeed * playerY` (см. раздел 4), с теми же layerSpeed.
- Lou (для будущей фичи "world rotation"): при подходе к кривой горизонт почти не движется; когда кривая целиком на экране (машина в повороте), горизонт быстро едет в сторону, противоположную повороту; при выходе из кривой скролл продолжается до конца кривой. Скроллить "по настройкам базового сегмента".
- ВЫВОД: скорость скролла брать от `curve` сегмента под камерой/игроком и интегрировать по пройденной длине, не по кадрам.

## 7. Ловушки, упомянутые автором, и портрет 9:16

Прямо от автора (статьи, комментарии в коде):
- Кривые: не мог до конца объяснить аккумуляторы x/dx (потом подтверждено, что 2-й порядок); "easy to go down some dead ends" — не пытаться делать "правильную" 3D-геометрию кривых (матрицы, вращение).
- Фон на холмах привязан к `playerY`, а не к наклону — упрощение.
- Коллизия со спрайтом не останавливает полностью (иначе нельзя объехать) — хак.
- AI наивен, рывки в трафике; у невидимых машин AI отключён (проезжают сквозь друг друга).
- Код "quick and dirty": глобальные переменные, нужен редактор трассы (спрайты расставляются программно); polish автор не планирует.
- GC: объекты `camera/screen` создаются заранее, чтобы не аллоцировать в игровом цикле.
- Lou: описывает то же дрожание на границе сегмента и то же решение (basePercent); у "Top Speed" на холмах бывают артефакты клиппинга спрайтов.

Мои замеченные в коде нюансы (проверено по исходникам): дубль `var offRoadDecel` в v4; `maxy = p2.y` (v1–v3) против `p1.y` (v4); цикл спрайтов `n > 0` пропускает ближайший сегмент; клэмп playerX -2..2 (v1–v3) против -3..3 (v4); необъявленная глобальная `index` в `updateCars`; `fog/clip/projection` считаются до `continue`.

Портрет 9:16 — ВЫВОДЫ (мои, в источниках этого нет):
1. FOV и изотропность: в коде `cameraDepth` масштабируется на `width/2` по x и `height/2` по y. В портрете (width < height) `height/2` по y вытянет дорогу вертикально. Рекомендация: использовать один множитель масштаба на обе оси (как у спрайтов) и задавать FOV по горизонтали. Если сохранить вертикальный FOV 100°, то при 9:16 горизонтальный FOV окажется ~ 2*atan(tan(50°)*9/16) ≈ 68° (расчёт) — туннельная картинка. Конкретные значения подбирать на глаз (отправная точка: горизонтальный FOV ~ 90–100°).
2. Горизонт: в коде всегда `height/2`. На 9:16 это середина высокого экрана: полэкрана неба, дорога только внизу. Вероятно, стоит вынести `horizonY` (~35–45% высоты) вместо `height/2` в формулу `screen.y`; тогда инвариант "точка под машиной = низ экрана" потребует пересчёта `cameraHeight/playerZ` под новый горизонт.
3. Ширина: roadWidth в пикселях сжимается вместе с шириной экрана; 3 полосы + обочина должны быть читаемы на телефоне — увеличить FOV или уменьшить `roadWidth` (спрайты масштабируются через `roadWidth`, остаются пропорциональны).
4. Высота камеры: большая `cameraHeight` (ползунок до 5000) даёт больше обзора вперёд — полезно в высоком кадре; подбирать вместе с `playerZ = cameraHeight*cameraDepth`.
5. drawDistance 300 сегментов (60000 ед.) для портрета можно сократить (дорога сходится в точку выше/ближе); туман завязан на `n/drawDistance`, плотность подбирать заново.
6. Кривые/центробежка заданы в мировых единицах и от разрешения не зависят, но визуальный боковой сдвиг в пикселях в узком экране меньше при той же `curve`; возможно, кривые придётся усилить.

## Приложение: что НЕ проверялось
- Спрайтшиты и фоны (`images/*.png`), `common.css`, `stats.js` — не читались.
- Игра не запускалась: поведение выведено чтением кода; числа с пометкой "(расчёт)" посчитаны вручную.
- Комментарии под статьями (кроме правок автора внутри статьи) не читались.
- Пункты раздела 7 про портрет — мои гипотезы, не из источников.
