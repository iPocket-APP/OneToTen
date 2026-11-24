import type { I18n } from './i18n.tsx';
import { brandName, defaultLocale, languages, locales, pagePath } from './locale.ts';
import type { PublicPage } from './locale.ts';

export type SitePage = PublicPage | 'room' | 'notFound';
type HeadTag = { tag: 'title' | 'meta' | 'link' | 'script'; attrs?: Record<string, string>; text?: string };

const robots = (content: string): HeadTag => ({ tag: 'meta', attrs: { name: 'robots', content } });

export function pageMetadata({ t, locale }: I18n, page: SitePage, origin?: string): HeadTag[] {
  const brand = brandName(locale);
  if (page === 'room') return [{ tag: 'title', text: t('roomTitle') + ' | ' + brand }, robots('noindex, nofollow')];
  if (page === 'notFound') return [{ tag: 'title', text: t('notFound') + ' | ' + brand }, robots('noindex')];

  const title = t(page === 'home' ? 'homeMetaTitle' : 'guideMetaTitle');
  const description = t(page === 'home' ? 'homeMetaDescription' : 'guideMetaDescription');
  const chinese = locale === defaultLocale;
  const social = (key: string, content: string): HeadTag => ({ tag: 'meta', attrs: { property: 'og:' + key, content } });
  const tags: HeadTag[] = [
    { tag: 'title', text: title },
    { tag: 'meta', attrs: { name: 'description', content: description } },
    social('site_name', brand), social('type', 'website'), social('locale', languages[locale].ogLocale),
    social('title', title), social('description', description),
    { tag: 'meta', attrs: { name: 'twitter:card', content: chinese ? 'summary_large_image' : 'summary' } },
  ];
  if (!origin) return [...tags, robots('noindex')];
  const url = origin + pagePath(locale, page);
  tags.push(
    { tag: 'link', attrs: { rel: 'canonical', href: url } },
    ...locales.map((alternate): HeadTag => ({ tag: 'link', attrs: {
      rel: 'alternate', hrefLang: alternate, href: origin + pagePath(alternate, page),
    } })),
    { tag: 'link', attrs: { rel: 'alternate', hrefLang: 'x-default', href: origin + pagePath(defaultLocale, page) } },
    social('url', url), social('image', origin + (chinese ? '/share-card.jpg' : '/brand-mark.png')),
    social('image:width', chinese ? '1200' : '192'), social('image:height', chinese ? '630' : '192'),
    social('image:alt', chinese ? t('homeMetaTitle') : brand),
  );
  if (page === 'home') tags.push({
    tag: 'script', attrs: { type: 'application/ld+json' },
    text: JSON.stringify({
      '@context': 'https://schema.org', '@type': 'WebSite', name: brand,
      alternateName: chinese ? 'One to Ten' : '一传十', url,
    }).replaceAll('<', '\\u003c'),
  });
  return tags;
}

export function updatePageMetadata(i18n: I18n, page: SitePage, origin?: string): void {
  const tags = document.createDocumentFragment();
  for (const { tag, attrs, text } of pageMetadata(i18n, page, origin)) {
    const element = document.createElement(tag);
    element.setAttribute('data-page-meta', '');
    for (const [key, value] of Object.entries(attrs ?? {})) element.setAttribute(key, value);
    if (text) element.textContent = text;
    tags.append(element);
  }
  for (const old of document.head.querySelectorAll('[data-page-meta]')) old.remove();
  document.head.append(tags);
}
