export interface SlideItem {
  id: string;
  title: string;
  image: string;
  alt: string;
  caption: string;
  tag?: string;
  description?: string;
}

export interface FeatureItem {
  id: string;
  title: string;
  description: string;
}

export interface ResourceLinkItem {
  id: string;
  name: string;
  url: string;
  displayUrl?: string;
  notes?: string;
  // The language this entry belongs to. Absent means both locales see it; a
  // value keeps it in that locale only. Used for the Telegram channel, which
  // is Russian: an English reader was being offered a link they cannot use
  // and will not follow, while GitHub Discussions serves them instead.
  lang?: 'en' | 'ru';
}

export interface DownloadVariantItem {
  id: string;
  variant: string;
  ships: string;
  notes: string;
}
