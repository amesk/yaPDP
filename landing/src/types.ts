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
}

export interface DownloadVariantItem {
  id: string;
  variant: string;
  ships: string;
  notes: string;
}
