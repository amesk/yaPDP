import { FEATURES_EN, FEATURES_RU } from '../data.ts';

interface FeaturesTableProps {
  lang: 'en' | 'ru';
}

export function FeaturesTable({ lang }: FeaturesTableProps) {
  const features = lang === 'en' ? FEATURES_EN : FEATURES_RU;

  return (
    <section id="features" className="my-6 w-full max-w-full">
      <hr className="border-0 border-t border-[#4a453a] my-6" />

      <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] mb-3 font-mono">
        {lang === 'en' ? 'About This Project' : 'О проекте yaPDP'}
      </h2>

      <p className="text-sm sm:text-base text-[#e0d8c8] leading-relaxed mb-4">
        {lang === 'en' ? (
          <>
            This is a <b>PDP‑11/70</b> emulator that just works out of the box — no plugins, no downloads, no configuration. Just open the page and you&apos;re standing in front of a DEC minicomputer.
          </>
        ) : (
          <>
            Это эмулятор <b>PDP‑11/70</b>, который работает прямо из коробки — без плагинов, загрузок и предварительной настройки. Просто откройте страницу — и вы у пульта мини-ЭВМ DEC.
          </>
        )}
      </p>

      <h3 className="text-lg font-bold text-[#f0e6c8] mt-6 mb-3 font-mono">
        {lang === 'en' ? 'What makes it special' : 'Ключевые особенности'}
      </h3>

      {/* Styled DEC amber feature table */}
      <div className="overflow-x-auto my-3 border border-[#4a453a] rounded bg-black/25 w-full max-w-full">
        <table className="w-full text-left text-xs sm:text-sm border-collapse">
          <thead>
            <tr className="border-b border-[#4a453a] bg-[#221e18]">
              <th className="py-2.5 px-3.5 text-[#f0e6c8] font-bold font-mono w-2/5 sm:w-1/4">
                {lang === 'en' ? 'Feature' : 'Компонент'}
              </th>
              <th className="py-2.5 px-3.5 text-[#f0e6c8] font-bold font-mono">
                {lang === 'en' ? 'Description' : 'Описание'}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#3a3528]">
            {features.map((item) => (
              <tr key={item.id} className="hover:bg-white/[0.02] transition-colors">
                <td className="py-2.5 px-3.5 text-[#e8d080] font-semibold align-top font-mono break-words sm:whitespace-nowrap">
                  {item.title}
                </td>
                <td className="py-2.5 px-3.5 text-[#d4c4a0] leading-relaxed align-top">
                  {item.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Narrative paragraphs from the original site */}
      <div className="space-y-3.5 mt-6 text-sm text-[#d4c4a0] leading-relaxed">
        {lang === 'en' ? (
          <>
            <p>
              PDP‑11 emulators are plentiful today. They span every platform and every level of ambition — from lightweight interpreters to cycle‑accurate recreations. But for all their differences they share the same sore spot: getting one up and running is a struggle. Configuration screens full of cryptic options, an engineer&apos;s interface built for utility rather than for the experience, and the eternal hunt for a disk image that actually works with this particular emulator — the part that should be effortless usually turns out to be the hardest.
            </p>
            <p>
              Solving those problems is necessary, but it is not the whole story. The other half of the equation is what emulation is really about — immersion. The spirit of the era, the hum of the power supply, paper rattling through the teletype, the soft glow of a phosphor screen. We emulate not merely to run old software, but to feel, for a while, what it was like to work with it.
            </p>
            <p>
              That is exactly what yaPDP sets out to do. It pairs a zero‑configuration, instant start — open the page and you&apos;re standing at the console of a PDP‑11/70 — with an authenticity that reaches down to the smallest detail, even the sound: the drone of the machine, the clatter of the Model 33 ASR, the rhythm of the line printer. Not just a faithful emulator. A faithful experience.
            </p>
          </>
        ) : (
          <>
            <p>
              Сегодня существует немало эмуляторов PDP‑11 на любой вкус — от легковесных интерпретаторов до потактово-точных моделей. Но при всех различиях у них одна общая проблема: запуск и настройка превращаются в испытание. Экраны конфигурации с непонятными параметрами, интерфейсы, созданные ради утилитарности, а не впечатлений, и вечный поиск подходящего дискового образа — то, что должно быть мгновенным, оказывается самым трудоемким.
            </p>
            <p>
              Решить эти проблемы необходимо, но это лишь половина задачи. Вторая половина — это то, ради чего вообще создается эмуляция: погружение. Дух эпохи, низкий гул трансформаторов, шелест бумаги в телетайпе, мягкое зеленое свечение люминофора. Мы эмулируем не просто чтобы запустить старый бинарник, а чтобы снова почувствовать, каково было за ним работать.
            </p>
            <p>
              Именно эту цель ставит перед собой yaPDP. Моментальный старт без настройки — вы открываете страницу и уже находитесь у консоли PDP‑11/70 — сочетается с вниманием к каждой детали, включая звуковое сопровождение: ровный гул машины, щелканье каретки Model 33 ASR, ритмичный стук построчного принтера. Не просто точный эмулятор. Точное ощущение эпохи.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
