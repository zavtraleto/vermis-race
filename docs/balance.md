# Журнал баланса

Каждая правка чисел в `src/data` — строка здесь.

| Дата | Параметр | Было | Стало | Почему | Что измерено |
| --- | --- | --- | --- | --- | --- |
| 2026-11-18 | все | — | стартовые значения из brief | инженерное предложение, ни разу не запускалось | — |
| 2026-11-18 | `K_HEADING` | — | 1 | заглушка в `src/sim/constants.ts`, пока нет сдвига фона | — |
| 2026-11-18 | `camera.json`: `fovDeg` 80 (горизонтальный), `height` 1000, `drawDistance` 300, `horizon` 0.375, экран 360×640 | — | стартовые | T3: изотропная проекция, горизонт на 37.5% сверху; `d0 = f·height/(H−horizonY) ≈ 536` > `segmentLength` | скриншот `straight`: горизонт y=240 |
| 2026-11-18 | `road.json`: `segmentLength` 200, `halfWidth` 400, `rumbleLength` 3, `lanes` 3, `rumbleWidth` 0.15, `laneMarkerWidth` 0.03 | — | стартовые | T3: ширина дороги внизу кадра = `halfWidth·(H−horizonY)/height` = 160 px из 180 | скриншот `straight` |
| 2026-11-18 | `scenarios.json`: `straight.ticks` 120 | — | 120 | T3 после слияния T2: скриншот `straight` берёт позицию машины игрока после 120 тиков (как эталонный пример) | `shots/straight.png` |
| 2026-11-18 | `sprites.json`: `capacity` 512; `player` baseY 0.9, width 0.24, height 0.08, steerThreshold 0.25, части силуэта | — | стартовые | T4: машина игрока в нижней части дорожной зоны (низ спрайта y=576 из 640, ~86×51 px); три кадра по знаку `steer` | `shots/straight.png`, `curve-left.png`, `curve-right.png` |
| 2026-11-18 | `sprites.json`: `posts` every 4, offset 1.4, width 30, height 200, capHeight 0.15, enabled true | — | стартовые | T4: заглушки столбов слоя 3 на обочинах (за rumble 1.15), ориентир скорости | те же скриншоты; 307 инстансов в обычной сцене |
| 2026-11-18 | `palette.json`: `player`, `carShadow`, `carWheel`, `carGlass`, `carLamp`, `post`, `postCap` | — | цвета из арт-библии | T4: заглушки спрайтов только из палитры арт-библии | гистограмма `curve-left`: `#f2f2f2` (машина) ярче rumble `#e8e8e8` — см. отчёт |
| 2026-11-18 | `scenarios.json`: `curve-left.curve` −2.5, `curve-right.curve` 2.5 (ticks 120); `stress` drawDistance 300, curve 1.5, fill 400 инстансов | — | стартовые | T4: скриншоты поворотов и стресс-сцена для замера на телефоне | зеркальность скриншотов: 49 px из 230 400 различаются |
