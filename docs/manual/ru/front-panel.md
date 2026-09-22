## Пультовая панель (страница Panel)

<!-- translated: needs review -->
Каждый тумблер, светодиод и поворотный переключатель настоящего PDP-11/70 воспроизведены точно. Страница Panel — это то место, где вы вводите загрузчик тумблерами так же, как инженеры DEC в 1970-х.

<!-- translated: needs review -->
![Пультовая панель PDP-11/70](assets/images/manual/panel.png)

Пультовая панель PDP-11/70, питание включено.

### Последовательности переключения тумблеров

<!-- translated: needs review -->
Простой «бегущий огонь» — введите это, чтобы увидеть, как пляшут светодиоды адреса и данных:

`Switch sequence: HALT, 001000, LOAD ADDRESS
012700, DEPOSIT
000001, DEPOSIT
006100, DEPOSIT
000005, DEPOSIT
000775, DEPOSIT
001000, LOAD ADDRESS, ENABLE, START`

<!-- translated: needs review -->
Перезапуск загрузчика:

`HALT, 120000, LOAD ADDRESS, ENABLE, START`

<!-- translated: needs review -->
Кнопка **Bootstrap now!** отказывается запускать машину, пока питание выключено:

<!-- translated: needs review -->
![Bootstrap now! — защита при выключенном питании](assets/images/manual/dialog-poweroff.png)

Bootstrap now! требует, чтобы машина была сначала включена.

<!-- translated: needs review -->
В том же диалоге есть ярлык к опции CONFIG **Auto-boot**: поставьте галочку, чтобы при каждом последующем включении питания автоматически выполнялась загрузка по умолчанию, не заходя на страницу Config. Выбор сохраняется и синхронизирован с галочкой на странице CONFIG.
