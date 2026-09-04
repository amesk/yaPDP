import { useState } from 'react';
import { RESOURCE_LINKS } from '../data.ts';
import { Terminal, Wand2, Copy, Check, ExternalLink } from 'lucide-react';

interface GetStartedProps {
  lang: 'en' | 'ru';
  onLaunchOnline: () => void;
}

export function GetStarted({ lang, onLaunchOnline }: GetStartedProps) {
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCode(text);
    setTimeout(() => setCopiedCode(null), 2000);
  };

  return (
    <section id="quick-boot" className="my-6 w-full max-w-full">
      <hr className="border-0 border-t border-[#4a453a] my-6" />

      <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] mb-3 font-mono">
        {lang === 'en' ? 'Get Started' : 'С чего начать'}
      </h2>

      <h3 className="text-lg font-bold text-[#f0e6c8] mt-4 mb-2 font-mono">
        {lang === 'en' ? 'Quick boot' : 'Быстрый запуск'}
      </h3>

      <ol className="list-decimal list-outside ml-5 text-xs sm:text-sm text-[#d4c4a0] space-y-1 mb-3">
        <li>
          {lang === 'en' ? (
            <>
              Open the{' '}
              <button
                onClick={onLaunchOnline}
                type="button"
                className="text-[#c8a860] hover:text-[#e8d080] underline font-semibold cursor-pointer"
              >
                PDP‑11/70 emulator
              </button>
              .
            </>
          ) : (
            <>
              Откройте{' '}
              <button
                onClick={onLaunchOnline}
                type="button"
                className="text-[#c8a860] hover:text-[#e8d080] underline font-semibold cursor-pointer"
              >
                эмулятор PDP‑11/70
              </button>
              .
            </>
          )}
        </li>
      </ol>

      <div className="p-3 my-3 rounded border-l-4 border-[#c8a860] bg-black/30 text-xs sm:text-sm text-[#d4c4a0] leading-relaxed">
        <p className="flex items-start gap-2">
          <Wand2 className="w-4 h-4 text-[#e8d080] flex-shrink-0 mt-0.5" />
          <span>
            {lang === 'en' ? (
              <>
                <strong className="text-[#f0e6c8]">In a hurry?</strong> Use the{' '}
                <strong className="text-[#e8d080]">magic wand</strong> button in the top-right corner of the window (it stays on every page except <strong>Info</strong>) — it does it all in one click: picks a guest OS, reconfigures the machine, reboots it, and types the boot (and login) for you.
              </>
            ) : (
              <>
                <strong className="text-[#f0e6c8]">Спешите?</strong> Нажмите кнопку{' '}
                <strong className="text-[#e8d080]">волшебной палочки (Magic Wand)</strong> в правом верхнем углу окна (она доступна на всех экранах, кроме <strong>Info</strong>) — она сделает всё в один клик: выберет гостевую ОС, переконфигурирует машину, перезагрузит её и введет команды загрузки и логина за вас.
              </>
            )}
          </span>
        </p>
      </div>

      <p className="text-xs sm:text-sm text-[#d4c4a0] mt-3 mb-2 font-medium">
        {lang === 'en' ? 'Otherwise, go the classic way:' : 'Или классическим путем через консоль:'}
      </p>

      <ol className="list-decimal list-outside ml-5 space-y-2 text-xs sm:text-sm text-[#d4c4a0] leading-relaxed">
        <li>
          {lang === 'en' ? 'At the ' : 'В командной строке '}
          <code className="bg-black/50 px-1.5 py-0.5 rounded text-[#e8d080] font-mono border border-[#4a453a]">
            Boot&gt;
          </code>{' '}
          {lang === 'en' ? 'prompt, type ' : 'введите '}
          <span className="inline-flex items-center gap-1 bg-black/60 px-2 py-0.5 rounded text-[#f0e6c8] font-mono border border-[#5a4a30]">
            boot rp1
            <button
              onClick={() => copyToClipboard('boot rp1')}
              type="button"
              aria-label="Copy command"
              className="text-[#c8a860] hover:text-[#e8d080] p-0.5"
            >
              {copiedCode === 'boot rp1' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            </button>
          </span>{' '}
          {lang === 'en' ? 'and press ENTER.' : 'и нажмите ENTER.'}
        </li>
        <li>
          {lang === 'en'
            ? 'BSD 2.11 will autoboot into multiuser mode. Login as '
            : 'BSD 2.11 автоматически загрузится в многопользовательский режим. Войдите как '}
          <code className="bg-black/50 px-1.5 py-0.5 rounded text-[#e8d080] font-mono border border-[#4a453a]">
            root
          </code>{' '}
          {lang === 'en' ? '(no password).' : '(пароль пустой).'}
        </li>
        <li>
          {lang === 'en' ? 'Try ' : 'Попробуйте команды '}
          <code className="bg-black/50 px-1 py-0.5 rounded text-[#e8d080] font-mono border border-[#4a453a]">ls</code>,{' '}
          <code className="bg-black/50 px-1 py-0.5 rounded text-[#e8d080] font-mono border border-[#4a453a]">ps -aux</code>,{' '}
          <code className="bg-black/50 px-1 py-0.5 rounded text-[#e8d080] font-mono border border-[#4a453a]">df</code>{' '}
          {lang === 'en' ? '— or compile a C program with ' : '— или скомпилируйте программу на Си с помощью '}
          <code className="bg-black/50 px-1 py-0.5 rounded text-[#e8d080] font-mono border border-[#4a453a]">cc</code>.
        </li>
      </ol>

      <h3 className="text-lg font-bold text-[#f0e6c8] mt-6 mb-3 font-mono">
        {lang === 'en' ? 'Links & downloads' : 'Ссылки и ресурсы'}
      </h3>

      {/* Styled Links table */}
      <div className="overflow-x-auto my-3 border border-[#4a453a] rounded bg-black/25 w-full max-w-full">
        <table className="w-full text-left text-xs sm:text-sm border-collapse">
          <thead>
            <tr className="border-b border-[#4a453a] bg-[#221e18]">
              <th className="py-2.5 px-3.5 text-[#f0e6c8] font-bold font-mono w-1/3">
                {lang === 'en' ? 'Resource' : 'Ресурс'}
              </th>
              <th className="py-2.5 px-3.5 text-[#f0e6c8] font-bold font-mono">
                {lang === 'en' ? 'URL / Reference' : 'Ссылка / Описание'}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#3a3528]">
            {RESOURCE_LINKS.map((link) => (
              <tr key={link.id} className="hover:bg-white/[0.02] transition-colors">
                <td className="py-2 px-3.5 text-[#e8d080] font-semibold align-top break-words sm:whitespace-nowrap font-mono">
                  {link.name}
                </td>
                <td className="py-2 px-3.5 text-[#d4c4a0] align-top">
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-[#c8a860] hover:text-[#e8d080] underline font-mono break-all"
                  >
                    <span>{link.displayUrl}</span>
                    <ExternalLink className="w-3 h-3 flex-shrink-0" />
                  </a>
                  {link.notes && (
                    <span className="text-xs text-[#a09278] block sm:inline sm:ml-2">
                      — {link.notes}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs sm:text-sm text-[#d4c4a0] mt-4 leading-relaxed">
        {lang === 'en' ? (
          <>
            The native desktop application (Windows x64) is built locally with{' '}
            <code className="bg-black/50 px-1.5 py-0.5 rounded text-[#e8d080] font-mono border border-[#4a453a] break-all">
              npm run desktop:full
            </code>{' '}
            — it produces NSIS/MSI installers, either in a tiny <strong>Minimal</strong> variant or a fully-offline <strong>Full</strong> variant with every disk/tape image bundled. See the README for details.
          </>
        ) : (
          <>
            Нативное десктопное приложение (Windows x64) собирается локально командой{' '}
            <code className="bg-black/50 px-1.5 py-0.5 rounded text-[#e8d080] font-mono border border-[#4a453a] break-all">
              npm run desktop:full
            </code>{' '}
            — на выходе формируются инсталляторы NSIS/MSI, либо в компактном варианте <strong>Minimal</strong>, либо в полностью автономном <strong>Full</strong> со всеми образами дисков и лент.
          </>
        )}
      </p>
    </section>
  );
}
