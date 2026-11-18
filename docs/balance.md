# Журнал баланса

Каждая правка чисел в `src/data` — строка здесь.

| Дата | Параметр | Было | Стало | Почему | Что измерено |
| --- | --- | --- | --- | --- | --- |
| 2026-11-18 | все | — | стартовые значения из brief | инженерное предложение, ни разу не запускалось | — |
| 2026-11-18 | `K_HEADING` | — | 1 | заглушка в `src/sim/constants.ts`, пока нет сдвига фона | — |
| 2026-11-18 | `camera.json`: `fovDeg` 80 (горизонтальный), `height` 1000, `drawDistance` 300, `horizon` 0.375, экран 360×640 | — | стартовые | T3: изотропная проекция, горизонт на 37.5% сверху; `d0 = f·height/(H−horizonY) ≈ 536` > `segmentLength` | скриншот `straight`: горизонт y=240 |
| 2026-11-18 | `road.json`: `segmentLength` 200, `halfWidth` 400, `rumbleLength` 3, `lanes` 3, `rumbleWidth` 0.15, `laneMarkerWidth` 0.03 | — | стартовые | T3: ширина дороги внизу кадра = `halfWidth·(H−horizonY)/height` = 160 px из 180 | скриншот `straight` |
| 2026-11-18 | `tracks/curves.json`: `easy` | — | 1.25 | T10: сдвиг центра дороги на дальней линии (300 сегм.) при постоянной кривой ≈ 158.9 px на единицу `curve` (камера/дорога из `camera.json`/`road.json`); easy = 199 px = 0.55 ширины экрана | тест `T10 curve classes vs screen`; на vmax удержание требует 37.5% руля |
| 2026-11-18 | `tracks/curves.json`: `medium` | — | 2.5 | T10: 397 px = 1.10 ширины экрана («примерно одна ширина»; точно одна = 2.27, округлено, чтобы `kCurve` вышел круглым) | тест `T10 curve classes vs screen` |
| 2026-11-18 | `tracks/curves.json`: `hard` | — | 4.5 | T10: 715 px = 1.99 ширины; на vmax полного руля не хватает (дефицит 0.525 полуширины/с), удерживается при sp < 0.792 | `calibration hard curve`; бот на `test-twisty`: max \|x\| 1.13 |
| 2026-11-18 | `cars/base.json`: `kCurve` | — | 1.5 | T11, brief §3: удержание x на medium при vmax руль s=0.75: s·steerRate·0.75 = medium·centrifugal·kCurve ⇒ kCurve = 5·s/medium = 1.5 | `calibration medium curve at vmax`: за 2 с dx = 0.000 (s=0.75), −0.75 (s=0.5), +0.75 (s=1.0) |
| 2026-11-18 | `cars/base.json`: `xLimit` | — | 2 | R18 [старт]: 2 полуширины, из brief | тесты R18 |
| 2026-11-18 | `tracks/test-twisty.json` | — | 18 секций, 3060 сегм. = 51 с на vmax | T10: серая петля, стороны чередуются, easy/medium/hard ×6/×7/×5, S-связка medium-medium (hold 60), длинная дуга medium hold 420; прямых > 90 сегм. нет | бот P (k=3), 2-й круг: max \|x\| easy 0.73, medium 0.73, hard 1.13; min speed 0.676; круг 52.3 с |
| 2026-11-18 | `scenarios.json`: `straight.ticks` 120 | — | 120 | T3 после слияния T2: скриншот `straight` берёт позицию машины игрока после 120 тиков (как эталонный пример) | `shots/straight.png` |
