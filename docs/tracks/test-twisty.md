# Трасса test-twisty

Сгенерировано `npm run trackmap` из `src/data/tracks` (R31). Схема: [test-twisty.svg](test-twisty.svg).

Длина 4814 сегментов, 80.2 с на `vmax`. Угол удержания и скорость — R22b из `cars/base.json` (установившийся дрифт на `hold` класса).

Схема псевдо-3D, сама по себе не замыкается: конец кольца отстоит от старта на 362 сегментов, суммарный поворот курса -57.2 рад (`K_HEADING` 1).

| # | фигура | сторона | сегментов | классы | угол удержания | скорость, vmax | hill |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 2 | hairpin | R | 275 | hard R | 0.79 | 0.88 | 40 |
| 3 | flick | L | 310 | hard L → hard R | 0.79 → 0.79 | 0.88 → 0.88 | -30 |
| 4 | kink | R | 80 | easy R | 0.25 | 0.96 | 20 |
| 5 | carousel | L | 500 | hard L | 0.79 | 0.88 | -60 |
| 6 | esses | R | 524 | medium R → medium L → medium R → medium L | 0.53 → 0.53 → 0.53 → 0.53 | 0.92 → 0.92 → 0.92 → 0.92 | 50 |
| 7 | tightening | R | 365 | medium R → hard R | 0.53 → 0.79 | 0.92 → 0.88 | -40 |
| 8 | kink | L | 80 | easy L | 0.25 | 0.96 | 0 |
| 9 | double | L | 390 | hard L → hard L | 0.79 → 0.79 | 0.88 → 0.88 | 60 |
| 10 | flick | R | 310 | hard R → hard L | 0.79 → 0.79 | 0.88 → 0.88 | -30 |
| 11 | opening | R | 370 | hard R → medium R | 0.79 → 0.53 | 0.88 → 0.92 | 30 |
| 12 | sweeper | L | 300 | medium L | 0.53 | 0.92 | -50 |
| 13 | hairpin | L | 275 | hard L | 0.79 | 0.88 | 40 |
| 14 | flick | R | 310 | hard R → hard L | 0.79 → 0.79 | 0.88 → 0.88 | -20 |
| 15 | tightening | L | 365 | medium L → hard L | 0.53 → 0.79 | 0.92 → 0.88 | 30 |
| 16 | sweeper | R | 300 | medium R | 0.53 | 0.92 | -40 |
