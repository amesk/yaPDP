import { DOWNLOAD_VARIANTS } from '../data.ts';
import { Download, ExternalLink, HardDrive, PackageCheck } from 'lucide-react';

interface DownloadSectionProps {
  lang: 'en' | 'ru';
}

export function DownloadSection({ lang }: DownloadSectionProps) {
  return (
    <section id="download" className="my-6">
      <hr className="border-0 border-t border-[#4a453a] my-6" />

      <h2 className="text-xl sm:text-2xl font-bold text-[#f0e6c8] mb-3 font-mono">
        {lang === 'en' ? 'Download' : 'Скачать приложение'}
      </h2>

      <p className="text-xs sm:text-sm text-[#d4c4a0] leading-relaxed mb-4">
        {lang === 'en' ? (
          <>
            Prefer a native app? The same emulator is packaged as an offline desktop application for Windows x64 with{' '}
            <a
              href="https://tauri.app/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#c8a860] hover:text-[#e8d080] underline font-semibold"
            >
              Tauri
            </a>
            . Two installer variants are available, so you can pick between a tiny download and a fully-offline bundle with every disk/tape image:
          </>
        ) : (
          <>
            Предпочитаете нативное приложение? Этот же эмулятор упакован как полностью автономное десктопное приложение для Windows x64 с помощью{' '}
            <a
              href="https://tauri.app/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#c8a860] hover:text-[#e8d080] underline font-semibold"
            >
              Tauri
            </a>
            . Доступно два варианта сборки: сверхкомпактный инсталлятор и полный автономный архив со всеми образами:
          </>
        )}
      </p>

      {/* Styled Download Variants table */}
      <div className="overflow-x-auto my-3 border border-[#4a453a] rounded bg-black/25 w-full max-w-full">
        <table className="w-full text-left text-xs sm:text-sm border-collapse">
          <thead>
            <tr className="border-b border-[#4a453a] bg-[#221e18]">
              <th className="py-2.5 px-3.5 text-[#f0e6c8] font-bold font-mono w-1/4">
                {lang === 'en' ? 'Variant' : 'Вариант'}
              </th>
              <th className="py-2.5 px-3.5 text-[#f0e6c8] font-bold font-mono w-1/3">
                {lang === 'en' ? 'Ships' : 'В комплекте'}
              </th>
              <th className="py-2.5 px-3.5 text-[#f0e6c8] font-bold font-mono">
                {lang === 'en' ? 'Notes' : 'Примечание'}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#3a3528]">
            {DOWNLOAD_VARIANTS.map((item) => (
              <tr key={item.id} className="hover:bg-white/[0.02] transition-colors">
                <td className="py-2.5 px-3.5 text-[#e8d080] font-semibold align-top break-words sm:whitespace-nowrap font-mono">
                  {item.variant}
                </td>
                <td className="py-2.5 px-3.5 text-[#f0e6c8] align-top font-mono text-xs">
                  {item.ships}
                </td>
                <td className="py-2.5 px-3.5 text-[#d4c4a0] align-top text-xs sm:text-sm">
                  {lang === 'en'
                    ? item.notes
                    : item.id === 'minimal'
                    ? 'Компактная загрузка (~3 МБ). Остальные образы подключаются перетаскиванием (drag & drop).'
                    : 'Больше по размеру, но все 16 ОС работают автономно без дополнительных файлов.'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 p-3.5 sm:p-4 rounded border border-[#5a4a30] bg-[#1e1a14] flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 w-full max-w-full">
        <div>
          <p className="text-xs sm:text-sm text-[#e0d8c8] font-medium">
            {lang === 'en'
              ? 'Download the latest binaries for Windows x64 (MSI / NSIS / Portable):'
              : 'Скачать свежие сборки для Windows x64 (MSI / NSIS / Portable):'}
          </p>
          <span className="text-[11px] text-[#a09278] font-mono">
            Directly from Alexei Eskenazi&apos;s GitHub release repository
          </span>
        </div>

        <a
          href="https://github.com/amesk/yaPDP/releases"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center gap-2 px-4 py-2 text-xs font-bold uppercase tracking-wider rounded border border-[#c8a860] bg-gradient-to-b from-[#5a4a30] to-[#3a3528] hover:from-[#6a5838] hover:to-[#4a4030] text-[#f0e6c8] hover:text-[#fff6e0] shadow-[inset_0_1px_0_rgba(255,200,80,0.15),0_1px_3px_rgba(0,0,0,0.5)] transition-all sm:whitespace-nowrap w-full sm:w-auto text-center"
        >
          <Download className="w-3.5 h-3.5 text-[#e8d080]" />
          <span>{lang === 'en' ? 'GitHub Releases Page' : 'Страница релизов GitHub'}</span>
          <ExternalLink className="w-3 h-3 text-[#c8a860]" />
        </a>
      </div>
    </section>
  );
}
