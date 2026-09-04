interface PersonalNoteProps {
  lang: 'en' | 'ru';
}

export function PersonalNote({ lang }: PersonalNoteProps) {
  return (
    <section id="story" className="my-6 w-full max-w-full">
      <hr className="border-0 border-t border-[#4a453a] my-6" />

      <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] mb-3 font-mono">
        {lang === 'en' ? 'A Personal Note' : 'Личная история'}
      </h2>

      <div className="space-y-3.5 text-xs sm:text-sm text-[#d4c4a0] leading-relaxed">
        {lang === 'en' ? (
          <>
            <p>
              I first saw DEC minicomputers as a child at my parents&apos; workplace. The blinking lights, the whir of disk drives, the smell of ozone and paper — it left an impression that never faded.
            </p>
            <p>
              My real hands‑on encounter came later, when I found myself in front of the Soviet clones of DEC hardware — the <strong className="text-[#f0e6c8]">SM‑4</strong> and <strong className="text-[#f0e6c8]">SM‑1420</strong> — running <strong className="text-[#f0e6c8]">RSX‑11M</strong>. And with them came C. The language that felt so clean, so powerful, and so close to the metal that everything else seemed clumsy by comparison. That was forty years ago.
            </p>
            <p>
              I went on to become a professional software developer — starting with low‑level programming, then building bare metal systems programming tools for x86, working on space communication systems and onboard navigation systems, and eventually leading projects of considerable size. But the feeling of powering up an SM‑4 with my own hands, watching the console lights dance, then walking to the next room to sit at a terminal — that stayed with me. I&apos;ve been trying to bring it back ever since.
            </p>
            <p>
              I never got to run <strong className="text-[#f0e6c8]">real UNIX</strong> on those machines. The Soviet replicas lived under RSX‑11M, and by the time I understood what UNIX V5 or 2.11 BSD truly meant, the world had already moved to x86 PCs. But decades later, thanks to the incredible work of Paul Nankervis, I can finally open a browser and boot Unix V5, BSD 2.11, Ultrix‑11, RSX‑11M, RSTS/E, RT‑11 — each one a time capsule of computing history.
            </p>
            <p>
              This project is the result: <strong className="text-[#e8d080]">yaPDP</strong>, a fully fledged PDP‑11/70 emulator that runs right in your browser, with an authentic front panel and a connected Model 33 ASR teletype — the operator&apos;s console I always dreamed of having next to my desk.
            </p>
            <p className="font-mono text-[#f0e6c8] text-base pt-1 italic">
              Welcome to the machine.
            </p>
          </>
        ) : (
          <>
            <p>
              Впервые я увидел мини-ЭВМ DEC еще ребенком, на работе у родителей. Мигающие лампочки регистров, шелест дисководов, запах озона и перфорированной бумаги — это впечатление осталось со мной навсегда.
            </p>
            <p>
              Настоящее знакомство состоялось позже, когда я оказался перед советскими аналогами архитектуры DEC — машинами <strong className="text-[#f0e6c8]">СМ‑4</strong> и <strong className="text-[#f0e6c8]">СМ‑1420</strong> под управлением ОС <strong className="text-[#f0e6c8]">ОСРВ (RSX‑11M)</strong>. И вместе с ними пришел Си. Язык, показавшийся настолько чистым, выразительным и близким к железу, что всё остальное на его фоне выглядело неуклюжим. Это было сорок лет назад.
            </p>
            <p>
              В дальнейшем я стал профессиональным разработчиком — начинал с низкоуровневого системного программирования, писал инструментарий для x86 bare-metal, работал над системами космической связи и бортовыми навигационными комплексами, руководил крупными программными проектами. Но то незабываемое ощущение, когда ты своими руками включаешь тумблер питания СМ‑4, смотришь на переливающийся танец огоньков консоли, а затем идешь в соседнюю комнату к алфавитно-цифровому терминалу — оно не отпускало. И я все эти годы мечтал вернуть то чувство.
            </p>
            <p>
              На тех машинах мне так и не довелось поработать в <strong className="text-[#f0e6c8]">настоящем UNIX</strong>. Советские реплики работали в основном под ОСРВ/RSX-11M, а к тому моменту, когда я понял истинную глубину Unix V5 или BSD 2.11, мир уже пересел на IBM PC. Но десятилетия спустя, благодаря великолепному труду Пола Нанкервиса (Paul Nankervis), я наконец могу открыть обычный браузер и запустить Unix V5, BSD 2.11, Ultrix‑11, RSX‑11M, RSTS/E, RT‑11 — каждая из которых является драгоценной капсулой времени истории компьютерной эры.
            </p>
            <p>
              Результатом этого пути стал <strong className="text-[#e8d080]">yaPDP</strong> — полноценный эмулятор PDP‑11/70 в вашем браузере, с аутентичной пультовой панелью и подключенным телетайпом Model 33 ASR — той самой консолью оператора, о которой я всегда мечтал рядом со своим рабочим столом.
            </p>
            <p className="font-mono text-[#f0e6c8] text-base pt-1 italic">
              Добро пожаловать к машине.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
