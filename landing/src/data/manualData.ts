export interface ManualSection {
  id: string;
  titleEn: string;
  titleRu: string;
  number?: string;
  subsections?: {
    id: string;
    titleEn: string;
    titleRu: string;
  }[];
}

export interface GuestOsEntry {
  disk: string;
  name: string;
  bootCommand: string;
  instructionsEn: string;
  instructionsRu: string;
  credentials?: string;
}

export interface FloatingControlEntry {
  image: string;
  nameEn: string;
  nameRu: string;
  whereEn: string;
  whereRu: string;
  descEn: string;
  descRu: string;
}

export interface ConfigTabEntry {
  id: string;
  titleEn: string;
  titleRu: string;
  image: string;
  itemsEn: { label: string; desc: string }[];
  itemsRu: { label: string; desc: string }[];
}

export const MANUAL_SECTIONS: ManualSection[] = [
  {
    id: 'quick-start',
    number: '1',
    titleEn: 'Quick Start',
    titleRu: 'Быстрый старт',
    subsections: [
      { id: 'magic-wand', titleEn: 'The magic wand', titleRu: 'Волшебная палочка' },
      { id: 'classic-way', titleEn: 'The classic way', titleRu: 'Классический способ' },
    ],
  },
  {
    id: 'front-panel',
    number: '2',
    titleEn: 'The Front Panel (Panel page)',
    titleRu: 'Пультовая панель (страница Panel)',
    subsections: [
      { id: 'switch-sequences', titleEn: 'Front panel switch sequences', titleRu: 'Последовательности переключения тумблеров' },
    ],
  },
  {
    id: 'console',
    number: '3',
    titleEn: 'The Operator Console',
    titleRu: 'Консоль оператора',
    subsections: [
      { id: 'teletype', titleEn: 'Model 33 ASR teletype', titleRu: 'Телетайп Model 33 ASR' },
      { id: 'vt52-console', titleEn: 'VT52 as the console', titleRu: 'VT52 в качестве консоли' },
      { id: 'vt100-console', titleEn: 'VT100 as the console', titleRu: 'VT100 в качестве консоли' },
    ],
  },
  {
    id: 'user-terminals',
    number: '4',
    titleEn: 'User Terminals (TTY 1 / TTY 2)',
    titleRu: 'Пользовательские терминалы (TTY 1 / TTY 2)',
  },
  {
    id: 'printer',
    number: '5',
    titleEn: 'The LP11 Line Printer (Printer page)',
    titleRu: 'Построчный принтер LP11 (страница Printer)',
  },
  {
    id: 'vt11',
    number: '6',
    titleEn: 'The VT11 Vector Display (Display page)',
    titleRu: 'Векторный дисплей VT11 (страница Display)',
  },
  {
    id: 'storage',
    number: '7',
    titleEn: 'Storage (paper tape, disk & tape images)',
    titleRu: 'Хранилище (перфолента, образы дисков и лент)',
  },
  {
    id: 'machine-state',
    number: '13',
    titleEn: 'Machine State (STATE button)',
    titleRu: 'Состояние машины (кнопка STATE)',
  },
  {
    id: 'config',
    number: '8',
    titleEn: 'Configuration (Config page)',
    titleRu: 'Конфигурация (страница Config)',
    subsections: [
      { id: 'config-equipment', titleEn: 'Equipment', titleRu: 'Оборудование' },
      { id: 'config-look-sound', titleEn: 'Look & sound', titleRu: 'Вид и звук' },
      { id: 'config-behaviour', titleEn: 'Behaviour', titleRu: 'Поведение' },
      { id: 'config-development', titleEn: 'Development', titleRu: 'Разработка' },
    ],
  },
  {
    id: 'guest-oses',
    number: '9',
    titleEn: 'Guest Operating Systems',
    titleRu: 'Гостевые операционные системы',
  },
  {
    id: 'controls',
    number: '10',
    titleEn: 'Buttons, Shortcuts & Indicators',
    titleRu: 'Кнопки, сочетания клавиш и индикаторы',
    subsections: [
      { id: 'switching-pages', titleEn: 'Switching pages', titleRu: 'Переключение страниц' },
      { id: 'floating-controls', titleEn: 'Floating controls', titleRu: 'Плавающие элементы управления' },
      { id: 'activity-lamps', titleEn: 'Sidebar activity lamps', titleRu: 'Индикаторы активности на боковой панели' },
    ],
  },
  {
    id: 'troubleshooting',
    number: '11',
    titleEn: 'Troubleshooting',
    titleRu: 'Устранение неполадок',
  },
  {
    id: 'desktop',
    number: '12',
    titleEn: 'The Desktop App',
    titleRu: 'Настольное приложение',
  },
];

export const GUEST_OS_TABLE: GuestOsEntry[] = [
  {
    disk: 'RK0',
    name: 'Unix V5',
    bootCommand: 'boot rk0',
    instructionsEn: 'unix → login as root',
    instructionsRu: 'unix → войти как root',
    credentials: 'root',
  },
  {
    disk: 'RK1',
    name: 'RT-11 v4.0',
    bootCommand: 'boot rk1',
    instructionsEn: 'boots immediately to monitor prompt',
    instructionsRu: 'загружается сразу в монитор RT-11',
  },
  {
    disk: 'RK2',
    name: 'RSTS V06C-03',
    bootCommand: 'boot rk2',
    instructionsEn: 'wizard answers START at the Option: prompt',
    instructionsRu: 'мастер вводит START на приглашение Option:',
  },
  {
    disk: 'RK3',
    name: 'XXDP (diagnostics)',
    bootCommand: 'boot rk3',
    instructionsEn: 'DEC field diagnostic operating system',
    instructionsRu: 'полевая диагностическая система DEC',
  },
  {
    disk: 'RK4',
    name: 'RT-11 3B Distribution',
    bootCommand: 'boot rk4',
    instructionsEn: 'RT-11 distribution baseline',
    instructionsRu: 'дистрибутив базовой версии RT-11',
  },
  {
    disk: 'TM0',
    name: 'RSTS 4B-17 (tape)',
    bootCommand: 'boot tm0',
    instructionsEn: 'follow ROLLIN restore procedure',
    instructionsRu: 'следуйте процедуре восстановления ROLLIN',
  },
  {
    disk: 'RL0',
    name: 'BSD 2.9',
    bootCommand: 'boot rl0',
    instructionsEn: 'rl(0,0)rlunix → CTRL/D → login root',
    instructionsRu: 'rl(0,0)rlunix → CTRL/D → логин root',
    credentials: 'root',
  },
  {
    disk: 'RL1',
    name: 'RSX-11M v3.2',
    bootCommand: 'boot rl1',
    instructionsEn: 'autostarts; enter the date when asked',
    instructionsRu: 'автостарт; введите дату по запросу',
  },
  {
    disk: 'RL2',
    name: 'RSTS/E v7.0',
    bootCommand: 'boot rl2',
    instructionsEn: 'wizard answers START at the Option: prompt',
    instructionsRu: 'мастер вводит START на приглашение Option:',
  },
  {
    disk: 'RL3',
    name: 'XXDP (extended)',
    bootCommand: 'boot rl3',
    instructionsEn: 'extended diagnostics library',
    instructionsRu: 'расширенная библиотека тестов XXDP',
  },
  {
    disk: 'RP0',
    name: 'ULTRIX-11 V3.1',
    bootCommand: 'boot rp0',
    instructionsEn: 'boots to a single-user shell (multi-user is a known emulator bug)',
    instructionsRu: 'загружается в однопользовательский режим (multi-user — известный баг эмулятора)',
  },
  {
    disk: 'RP1',
    name: 'BSD 2.11',
    bootCommand: 'boot rp1',
    instructionsEn: 'autoboots to multiuser, login root (no password)',
    instructionsRu: 'автозагрузка в многопользовательский режим, логин root (без пароля)',
    credentials: 'root (no password)',
  },
  {
    disk: 'RP2',
    name: 'RSTS/E v9.6',
    bootCommand: 'boot rp2',
    instructionsEn: 'boots to the date prompt; then 11,70 / PDP',
    instructionsRu: 'загружается до запроса даты; далее 11,70 / PDP',
    credentials: '11,70 (PDP)',
  },
  {
    disk: 'RP3',
    name: 'RSX-11M v4.6',
    bootCommand: 'boot rp3',
    instructionsEn: 'autostarts; enter date/time when asked',
    instructionsRu: 'автостарт; введите дату и время по запросу',
  },
  {
    disk: 'RP4',
    name: 'RSTS/E v10.1',
    bootCommand: 'boot rp4',
    instructionsEn: 'boots to the date prompt; then 11,70 / PDP',
    instructionsRu: 'загружается до запроса даты; далее 11,70 / PDP',
    credentials: '11,70 (PDP)',
  },
];

export const CONFIG_TABS_DATA: ConfigTabEntry[] = [
  {
    id: 'equipment',
    titleEn: 'Equipment',
    titleRu: 'Оборудование',
    image: 'assets/images/manual/config-equipment.png',
    itemsEn: [
      { label: 'Console terminal', desc: 'The operator console (tty0): a Model 33 ASR teletype, a DECscope VT52 or a DEC VT100.' },
      { label: 'User terminals', desc: 'Two user terminals (TTY 1 / TTY 2), each `None | VT52 | VT100` and each with its own sidebar page; the number of terminals is read off the two selects, and TT2 can only be filled once TT1 is.' },
      { label: 'Line printer (LP11)', desc: 'Install the animated LP11 line printer on its own Printer page.' },
      { label: 'VT11 graphics display', desc: 'Install the DEC VT11 vector-graphics terminal on its own Display page.' },
      { label: 'Teletype print width', desc: '72 or 80 columns for the Model 33 ASR console (a teletype is at most an 80-column machine).' },
      { label: 'Printer width', desc: '72/80/100/132 columns for the LP11 printer page.' },
      { label: 'Teletype speed', desc: 'Authentic (real 110-baud Model 33 ASR, ~10 chars/sec) or fast development pace.' },
      { label: 'Upper Case Only', desc: 'Send letters from physical keyboard in upper case (authentic Model 33 ASR); off by default so lower-case passes through.' },
      { label: 'Force PDP Output Uppercase', desc: 'Print machine output in upper case (authentic Model 33 ASR, which has no lower-case type); on by default — the paper tape keeps the raw code, and a VT52 console is not affected.' },
    ],
    itemsRu: [
      { label: 'Консольный терминал', desc: 'Консоль оператора (tty0): телетайп Model 33 ASR, видеотерминал DECscope VT52 или DEC VT100.' },
      { label: 'Пользовательские терминалы', desc: 'Два пользовательских терминала (TTY 1 / TTY 2), каждый — `None | VT52 | VT100`, со своей вкладкой в боковой панели; количество определяется выбором, а TT2 можно задать только после TT1.' },
      { label: 'Построчный принтер (LP11)', desc: 'Подключить анимированный принтер LP11 на отдельной странице Printer.' },
      { label: 'Графический дисплей VT11', desc: 'Подключить векторный графический процессор DEC VT11 на странице Display.' },
      { label: 'Ширина печати телетайпа', desc: '72 или 80 колонок для консоли Model 33 ASR (телетайп вмещает не более 80 символов).' },
      { label: 'Ширина бумаги принтера', desc: '72/80/100/132 колонки для страницы принтера LP11.' },
      { label: 'Скорость телетайпа', desc: 'Аутентичная (настоящие 110 бод, ~10 симв/сек) или ускоренная для быстрой разработки.' },
      { label: 'Только заглавные (Upper Case)', desc: 'Отправлять с физической клавиатуры буквы в верхнем регистре; по умолчанию выключено для строчных букв Unix.' },
      { label: 'Force PDP Output Uppercase', desc: 'Печатать вывод PDP в верхнем регистре (настоящий Model 33 ASR не имеет строчных литер); включено по умолчанию — перфолента хранит исходный код, а на VT52 опция не влияет.' },
    ],
  },
  {
    id: 'look-sound',
    titleEn: 'Look & sound',
    titleRu: 'Вид и звук',
    image: 'assets/images/manual/config-visual.png',
    itemsEn: [
      { label: 'VT100 key click', desc: 'Audible key-click feedback on VT100 terminals; the DECscope keyboard was mechanical and has no click to make, so the field dims when no VT100 is installed.' },
      { label: 'VT100 phosphor', desc: 'The VT100 tube: P4 white (the phosphor it was introduced on) or P1 green. The DECscope is pinned to P4 — it was never sold with another.' },
      { label: 'VT52 reverse video', desc: 'Historical DECscope reverse-video mode: black text on white phosphor. It is the DECscope’s own switch — a VT100 shows inverse text only when the software asks for it with the SGR 7 attribute.' },
      { label: 'CRT effects', desc: 'Pure-CSS CRT simulation: brightness flicker, phosphor shimmer and vertical-hold roll band.' },
      { label: 'Machine hum', desc: 'Ambient power-supply hum and cooling fan noise while the machine is powered on.' },
      { label: 'Photo backdrop', desc: 'Show the authentic PDP-11 machine-room photo behind the pages.' },
    ],
    itemsRu: [
      { label: 'Щелчок клавиш VT100', desc: 'Звуковой отклик нажатия клавиш на терминалах VT100; клавиатура DECscope механическая, щёлкать ей нечем, поэтому без установленного VT100 поле неактивно.' },
      { label: 'Люминофор VT100', desc: 'Экран VT100: белый P4 (с ним терминал и выпускался) или зелёный P1. У DECscope люминофор всегда P4 — другого не существовало.' },
      { label: 'Инверсное видео VT52', desc: 'Исторический режим обратного видео DECscope: черный текст на белом фоне. Это собственный переключатель DECscope; VT100 показывает инверсию только по атрибуту SGR 7 от программы.' },
      { label: 'Эффекты ЭЛТ (CRT)', desc: 'CSS-симуляция кинескопа: мерцание люминофора, микро-шум и полоса кадровой развертки.' },
      { label: 'Гул машины (Machine hum)', desc: 'Фоновый гул трансформаторов блока питания и шум вентиляторов охлаждения при включении.' },
      { label: 'Фото-фон машинного зала', desc: 'Отображение фотографического фона машинного зала PDP-11 на заднем плане.' },
    ],
  },
  {
    id: 'behaviour',
    titleEn: 'Behaviour',
    titleRu: 'Поведение',
    image: 'assets/images/manual/config-behaviour.png',
    itemsEn: [
      { label: 'Reboot confirmation', desc: 'Ask before rebooting the machine; the "Don\'t show this warning anymore" option can be restored here at any time.' },
      { label: 'Help Me! sticker', desc: 'Show the operator\'s hand-written bootstrap sticky note on the Panel page.' },
      { label: 'Machine power', desc: 'The machine is powered on; switching it off powers down the PDP-11 (POWER LOCK in off position).' },
      { label: 'Auto-boot', desc: 'Start the default bootstrap automatically when the machine is powered on.' },
      { label: 'First-run hint', desc: 'Replay the first-run welcome overlay with quick-start boot suggestions on the next launch.' },
    ],
    itemsRu: [
      { label: 'Подтверждение перезагрузки', desc: 'Запрашивать подтверждение перед перезапуском; опцию "Больше не показывать" можно вернуть здесь в любое время.' },
      { label: 'Наклейка «Help Me!»', desc: 'Показывать рукописную памятку оператора по начальной загрузке на пультовой панели.' },
      { label: 'Питание машины', desc: 'Переключатель питания: выключение обесточивает виртуальный PDP-11 (замок POWER LOCK).' },
      { label: 'Автозагрузка (Auto-boot)', desc: 'Автоматически выполнять встроенный начальный загрузчик при включении питания.' },
      { label: 'Подсказка первого запуска', desc: 'Повторно показать вступительное приветственное окно с советами при следующем открытии.' },
    ],
  },
  {
    id: 'development',
    titleEn: 'Development',
    titleRu: 'Разработка',
    image: 'assets/images/manual/config-development.png',
    itemsEn: [
      { label: 'Plain text input instead of the canvas CRT', desc: 'Render the terminal as a text field instead of the canvas CRT, giving native text selection and Windows Clipboard (Ctrl+C / Ctrl+V / right-click paste) for fast source-code entry; loses SGR attributes (bold/underline/reverse). It acts on the page, so a VT52 and a VT100 terminal are both rendered this way.' },
    ],
    itemsRu: [
      { label: 'Plain text input instead of the canvas CRT', desc: 'Обычное текстовое поле вместо Canvas CRT: нативное выделение текста и системный буфер обмена (Ctrl+C / Ctrl+V / вставка правой кнопкой) для быстрого ввода исходного кода; теряются атрибуты SGR (жирный/подчёркивание/инверсия). Режим действует на страницу, поэтому так отображаются и терминалы VT52, и терминалы VT100.' },
    ],
  },
];

export const FLOATING_CONTROLS_DATA: FloatingControlEntry[] = [
  {
    image: 'assets/images/manual/btn-magicwand.png',
    nameEn: 'Magic wand',
    nameRu: 'Волшебная палочка',
    whereEn: 'Top-right corner (every page except Info)',
    whereRu: 'Верхний правый угол (все страницы кроме Info)',
    descEn: 'Quick-boot picker — chooses a guest OS, reconfigures machine profile, reboots and types the boot/login commands automatically.',
    descRu: 'Меню быстрого запуска — выбирает гостевую ОС, переконфигурирует оборудование, перезагружает и автоматически набирает команды загрузки и логина.',
  },
  {
    image: 'assets/images/manual/btn-reboot.png',
    nameEn: 'Reboot',
    nameRu: 'Перезагрузка',
    whereEn: 'Top-left corner, just right of the sidebar',
    whereRu: 'Верхний левый угол, справа от боковой панели',
    descEn: 'Round button with restart icon. Restarts the machine; when Auto-boot is enabled it also boots the built-in default loader. Asks for confirmation by default.',
    descRu: 'Круглая кнопка со значком рестарта. Перезапускает машину; при включенном Auto-boot сразу запускает загрузчик. По умолчанию запрашивает подтверждение.',
  },
  {
    image: 'assets/images/manual/btn-mute.png',
    nameEn: 'Mute',
    nameRu: 'Без звука (Mute)',
    whereEn: 'Bottom-left corner, just right of the sidebar',
    whereRu: 'Нижний левый угол, справа от боковой панели',
    descEn: 'Round button that toggles all sounds at once — power hum, teletype/LP11 printing, paper feed/tear, key clicks and the bell. Persisted across sessions.',
    descRu: 'Круглая кнопка, выключающая все звуки разом — гул трансформатора, печать телетайпа и LP11, шелест бумаги, щелчки клавиш и звонок.',
  },
  {
    image: 'assets/images/manual/btn-fullscreen.png',
    nameEn: 'Fullscreen',
    nameRu: 'Полноэкранный режим',
    whereEn: 'Bottom-right corner of the window',
    whereRu: 'Нижний правый угол окна',
    descEn: 'Floating button that hides the browser/system chrome (address bar, window frame, taskbar) while leaving the emulator UI untouched. Press again or Esc to return.',
    descRu: 'Кнопка скрытия элементов браузера и операционной системы для максимального погружения в машинный зал. Повторное нажатие или Esc возвращает обычный вид.',
  },
  {
    image: 'assets/images/manual/btn-zoom.png',
    nameEn: 'Terminal zoom',
    nameRu: 'Масштаб терминала',
    whereEn: 'Bottom-right corner, left of the fullscreen button',
    whereRu: 'Нижний правый угол, слева от кнопки полного экрана',
    descEn: 'Floating button that hides the terminal cabinet and grows the tube to the largest 4:3 box the window allows, clearing the floating corner controls. It works on either video terminal — a DECscope VT52 or a DEC VT100. The state is per terminal (console TT0, TTY 1, TTY 2) and is remembered between sessions. The icon mirrors what is on screen — a display while the cabinet is shown, the whole terminal in zoom mode — and the button is available only on the pages that show a video terminal.',
    descRu: 'Кнопка скрывает корпус терминала и увеличивает экран до максимального размера 4:3, который позволяет окно, не задевая угловые кнопки. Работает с любым видеотерминалом — DECscope VT52 или DEC VT100. Состояние — индивидуальное для каждого терминала (консоль TT0, TTY 1, TTY 2) и запоминается между сессиями. Иконка отражает текущий вид: дисплей, пока показан корпус, и сам терминал в режиме увеличения. Кнопка доступна только на страницах, где показан видеотерминал.',
  },
];
