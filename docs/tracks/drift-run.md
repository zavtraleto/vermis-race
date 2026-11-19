# Трасса drift-run

Сгенерировано `npm run trackmap` из `src/data/tracks` (R31). Схема: [drift-run.svg](drift-run.svg).

Длина 6425 сегментов, 107.1 с на `vmax`. Угол удержания и скорость — R22b из `cars/base.json` (установившийся дрифт на `hold` класса).

Схема псевдо-3D, сама по себе не замыкается: конец кольца отстоит от старта на 888 сегментов, суммарный поворот курса -5.0 рад (`K_HEADING` 1).

Повороты — 5365 сегментов (84% круга); из них нужен дрифт (`hard`, `sharp`) на 62% (R31b: 45–65%).

| # | фигура | сторона | сегментов | классы | угол удержания | скорость, vmax | hill |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 2 | kink | R | 80 | easy R | 0.25 | 0.98 | 20 |
| 3 | sweeper | L | 300 | medium L | 0.55 | 0.96 | -20 |
| 4 | kink | L | 80 | easy L | 0.25 | 0.98 | 30 |
| 5 | hairpin | R | 275 | hard R | 0.83 | 0.93 | -30 |
| 6 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 7 | sweeper | R | 300 | medium R | 0.55 | 0.96 | 40 |
| 8 | sweeper | L | 300 | medium L | 0.55 | 0.96 | -40 |
| 9 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 10 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 11 | hook | R | 130 | sharp R | 0.98 | 0.92 | 30 |
| 12 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 13 | tightening | L | 365 | medium L → hard L | 0.55 → 0.83 | 0.96 → 0.93 | -30 |
| 14 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 15 | flick | R | 310 | hard R → hard L | 0.83 → 0.83 | 0.93 → 0.93 | 0 |
| 16 | sweeper | L | 300 | medium L | 0.55 | 0.96 | 0 |
| 17 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 18 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 19 | scurve | L | 470 | hard L → hard R | 0.83 → 0.83 | 0.93 → 0.93 | 50 |
| 20 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 21 | double | R | 390 | hard R → hard R | 0.83 → 0.83 | 0.93 → 0.93 | -50 |
| 22 | kink | L | 80 | easy L | 0.25 | 0.98 | 0 |
| 23 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 24 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 25 | flick | L | 310 | hard L → hard R | 0.83 → 0.83 | 0.93 → 0.93 | 40 |
| 26 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 27 | chicane | R | 175 | sharp R → sharp L | 0.98 → 0.98 | 0.92 → 0.92 | -40 |
| 28 | opening | L | 370 | hard L → medium L | 0.83 → 0.55 | 0.93 → 0.96 | 0 |
| 29 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 30 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 31 | spiral | R | 370 | medium R → hard R → sharp R | 0.55 → 0.83 → 0.98 | 0.96 → 0.93 → 0.92 | 60 |
| 32 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 33 | switchback | L | 590 | hard L → straight L → hard R | 0.83 → — → 0.83 | 0.93 → 1.00 → 0.93 | -60 |
| 34 | kink | R | 80 | easy R | 0.25 | 0.98 | 0 |
| 35 | hook | L | 130 | sharp L | 0.98 | 0.92 | 0 |
| 36 | straight | R | 60 | straight R | — | 1.00 | 0 |
| 37 | straight | R | 60 | straight R | — | 1.00 | 0 |
