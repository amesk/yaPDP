import { Mail, Heart } from 'lucide-react';

interface AcknowledgmentsProps {
  lang: 'en' | 'ru';
}

export function Acknowledgments({ lang }: AcknowledgmentsProps) {
  return (
    <section className="my-6 w-full max-w-full">
      <hr className="border-0 border-t border-[#4a453a] my-6" />

      <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] mb-3 font-mono">
        {lang === 'en' ? 'Acknowledgments' : 'Благодарности'}
      </h2>

      <p className="text-xs sm:text-sm text-[#d4c4a0] italic mb-4">
        {lang === 'en'
          ? 'This project stands on the shoulders of giants.'
          : 'Этот проект стоит на плечах гигантов.'}
      </p>

      {/* Paul Nankervis */}
      <div className="mb-4">
        <h3 className="text-base sm:text-lg font-bold text-[#f0e6c8] mb-2 font-mono">
          Paul Nankervis — Original PDP‑11 Emulator
        </h3>
        <p className="text-xs sm:text-sm text-[#d4c4a0] leading-relaxed mb-2">
          {lang === 'en' ? (
            <>
              Paul wrote the original{' '}
              <a
                href="https://github.com/paulnank/pdp11-js"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#c8a860] hover:text-[#e8d080] underline"
              >
                pdp11-js
              </a>{' '}
              emulator, which this repository is forked from. His meticulous work — cycle‑accurate CPU emulation, beautifully rendered front panels, and a meticulously curated collection of vintage operating systems — made this project possible.
            </>
          ) : (
            <>
              Пол создал оригинальный эмулятор{' '}
              <a
                href="https://github.com/paulnank/pdp11-js"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#c8a860] hover:text-[#e8d080] underline"
              >
                pdp11-js
              </a>
              , форком которого является данный проект. Его выдающийся труд — потактово-точная эмуляция процессора, детально прорисованная пультовая панель и бережно собранная коллекция исторических дистрибутивов ОС — сделали yaPDP возможным.
            </>
          )}
        </p>

        <blockquote className="my-3 py-2 px-3.5 border-l-4 border-[#c8a860] rounded-r bg-black/20 text-xs sm:text-sm text-[#d4c4a0] italic">
          <p>
            &quot;I met my core objective — I can now see the RSTS/E console light pattern that I was looking for.&quot;
          </p>
          <span className="text-xs text-[#a09278] not-italic block mt-1">
            — Paul Nankervis
          </span>
        </blockquote>
      </div>

      {/* Norbert Landsteiner */}
      <div className="mb-5">
        <h3 className="text-base sm:text-lg font-bold text-[#f0e6c8] mb-2 font-mono">
          Norbert Landsteiner (mass:werk) — Google60 Teletype
        </h3>
        <p className="text-xs sm:text-sm text-[#d4c4a0] leading-relaxed">
          {lang === 'en' ? (
            <>
              The Model 33 ASR teletype emulation is adapted from{' '}
              <a
                href="https://www.masswerk.at/google60/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#c8a860] hover:text-[#e8d080] underline"
              >
                Google60
              </a>{' '}
              by <strong className="text-[#f0e6c8]">Norbert Landsteiner</strong> of{' '}
              <a
                href="https://www.masswerk.at/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#c8a860] hover:text-[#e8d080] underline"
              >
                mass:werk
              </a>
              . Google60 is a brilliant simulation of the Google search interface as it would have appeared on a Model 33 ASR Teletype in the 1960s/1970s. Norbert&apos;s meticulous implementation — from the 3D keycaps to the paper advance animation and authentic sound effects — brings the teletype to life. This project repurposes his engine as the operator console for the PDP‑11.
            </>
          ) : (
            <>
              Эмуляция телетайпа Model 33 ASR адаптирована из проекта{' '}
              <a
                href="https://www.masswerk.at/google60/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#c8a860] hover:text-[#e8d080] underline"
              >
                Google60
              </a>{' '}
              авторства <strong className="text-[#f0e6c8]">Норберта Ландштайнера (Norbert Landsteiner)</strong> из{' '}
              <a
                href="https://www.masswerk.at/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#c8a860] hover:text-[#e8d080] underline"
              >
                mass:werk
              </a>
              . От трехмерных клавиш до анимации подачи рулонной бумаги и аутентичных щелчков механики — этот движок оживляет телетайп и служит консолью оператора в yaPDP.
            </>
          )}
        </p>
      </div>

      {/* Additional Sources */}
      <div className="mb-6">
        <h3 className="text-sm sm:text-base font-bold text-[#f0e6c8] mb-2 font-mono">
          {lang === 'en' ? 'Additional Sources' : 'Дополнительные архивы и сообщества'}
        </h3>
        <ul className="list-disc list-outside ml-5 space-y-1 text-xs sm:text-sm text-[#d4c4a0]">
          <li>
            <a
              href="http://bitsavers.org/pdf/dec/pdp11/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#c8a860] hover:text-[#e8d080] underline font-medium"
            >
              Bitsavers
            </a>{' '}
            — DEC PDP‑11 documentation archive
          </li>
          <li>
            <a
              href="http://bitsavers.org/bits/DEC/pdp11/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#c8a860] hover:text-[#e8d080] underline font-medium"
            >
              Bitsavers Software
            </a>{' '}
            — PDP‑11 software and disk images
          </li>
          <li>
            <a
              href="https://www.tuhs.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#c8a860] hover:text-[#e8d080] underline font-medium"
            >
              The Unix Heritage Society (TUHS)
            </a>{' '}
            — Preserving UNIX history
          </li>
          <li>
            <a
              href="http://www.rsts.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#c8a860] hover:text-[#e8d080] underline font-medium"
            >
              RSTS.ORG
            </a>{' '}
            — RSTS/E community and software preservation
          </li>
        </ul>
      </div>

      <hr className="border-0 border-t border-[#4a453a] my-6" />

      {/* Sign-off by Alexei Eskenazi */}
      <div className="pt-2 text-xs sm:text-sm text-[#d4c4a0] space-y-2">
        <p className="italic text-[#e8d080] font-serif text-base">
          {lang === 'en' ? 'Happy emulating!' : 'Приятной эмуляции!'}
        </p>
        <p className="leading-relaxed">
          — Alexei Eskenazi{' '}
          <a
            href="mailto:alexei.eskenazi@gmail.com"
            className="text-[#c8a860] hover:text-[#e8d080] underline font-mono inline-flex items-center gap-1 break-all"
          >
            <Mail className="w-3.5 h-3.5 shrink-0" />
            <span>amesk&lt;alexei.eskenazi@gmail.com&gt;</span>
          </a>{' '}
          (<em className="text-[#c8b890]">{lang === 'en' ? 'author and maintainer of yaPDP' : 'автор и разработчик yaPDP'}</em>)
          <br />
          — <em className="text-[#a09278]">{lang === 'en' ? 'Fork maintained with love for the DEC era' : 'Форк создан и поддерживается с любовью к золотой эпохе DEC'}</em>
        </p>
      </div>
    </section>
  );
}
