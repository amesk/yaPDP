interface WhoIsThisForProps {
  lang: 'en' | 'ru';
}

export function WhoIsThisFor({ lang }: WhoIsThisForProps) {
  return (
    <section className="my-6 w-full max-w-full">
      <hr className="border-0 border-t border-[#4a453a] my-6" />

      <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] mb-3 font-mono">
        {lang === 'en' ? 'Who Is This For?' : 'Для кого этот проект?'}
      </h2>

      <p className="text-sm text-[#d4c4a0] mb-3">
        {lang === 'en'
          ? 'As it turns out, rather a lot of people:'
          : 'Как оказалось, для очень многих:'}
      </p>

      <ul className="space-y-3 text-xs sm:text-sm text-[#d4c4a0] list-disc list-outside ml-5 leading-relaxed">
        {lang === 'en' ? (
          <>
            <li>
              <strong className="text-[#f0e6c8]">Those who were there.</strong> If you remember the clatter of a line printer or the smell of a warm front panel, this is a one‑way ticket back to the machine room — no time machine, no soldering iron and no security clearance required.
            </li>
            <li>
              <strong className="text-[#f0e6c8]">Those who arrived later.</strong> If you were born after the PDP‑11 was gently retired, this is where a surprising share of today&apos;s mainstream ideas began: time‑sharing, multiuser systems, hierarchical file systems, the C language, Unix itself. It all started somewhere. This is that somewhere.
            </li>
            <li>
              <strong className="text-[#f0e6c8]">Museums of computing history.</strong> An interactive exhibit that never needs dusting, winding, or a helpful gentleman in the basement with a box of spare transistors.
            </li>
            <li>
              <strong className="text-[#f0e6c8]">Students and the merely curious.</strong> A fine instrument for learning — from the days when trees were green, the sky was blue, and a computer announced its thinking with a sound you could actually hear and lights that actually showed something useful.
            </li>
          </>
        ) : (
          <>
            <li>
              <strong className="text-[#f0e6c8]">Для тех, кто застал ту эпоху.</strong> Если вы помните грохот АЦПУ или запах нагретой пультовой панели, это билет в один конец прямо в машинный зал — без машины времени, без паяльника и без допуска к гостайне.
            </li>
            <li>
              <strong className="text-[#f0e6c8]">Для тех, кто пришел позже.</strong> Если вы родились уже после того, как PDP‑11 ушли на заслуженный покой, именно здесь зародилась львиная доля современных концепций: разделение времени, многопользовательские ОС, иерархические файловые системы, язык Си и сам Unix. Все с чего-то начиналось. Это то самое начало.
            </li>
            <li>
              <strong className="text-[#f0e6c8]">Для музеев истории вычислительной техники.</strong> Интерактивный живой экспонат, с которого не нужно сдувать пыль и для которого не требуется пожилой инженер в подвале с коробкой запасных транзисторов.
            </li>
            <li>
              <strong className="text-[#f0e6c8]">Для студентов и любознательных.</strong> Прекрасный инструмент для изучения архитектуры — из тех времен, когда деревья были зеленее, небо выше, а компьютер сообщал о своей мыслительной деятельности реальным звуком и огнями индикаторов, отображавшими реальные регистры.
            </li>
          </>
        )}
      </ul>
    </section>
  );
}
