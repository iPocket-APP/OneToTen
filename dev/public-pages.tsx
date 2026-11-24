import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup, renderToString } from 'react-dom/server';
import type { Plugin } from 'vite';
import { Home } from '../src/browser/home.tsx';
import { I18nContext, loadI18n, withMarkup } from '../src/browser/i18n.tsx';
import type { I18n } from '../src/browser/i18n.tsx';
import { defaultLocale, direction, locales, pagePath } from '../src/browser/locale.ts';
import type { Locale, PublicPage } from '../src/browser/locale.ts';
import { pageMetadata } from '../src/browser/page-metadata.ts';
import type { SitePage } from '../src/browser/page-metadata.ts';
import { Guide, NotFound } from '../src/browser/site-pages.tsx';

const publicPagesByType = { home: 'index.html', guide: 'guide.html' } as const;
const publicEntries = (Object.entries(publicPagesByType) as [PublicPage, string][]).flatMap(([page, template]) =>
  locales.map((locale) => {
    const path = pagePath(locale, page);
    return { page, locale, path, template, file: path.slice(1) + (page === 'home' ? 'index.html' : '.html') };
  }));
const publicByFile = new Map(publicEntries.map((entry) => ['/' + entry.file, entry]));
const privateEntries = [
  { page: 'room', file: 'app.html' }, { page: 'notFound', file: '404.html' },
] as const;

export function siteOrigin(value: string | undefined): string | undefined {
  if (!value) return;
  const url = URL.parse(value);
  if (!url || url.protocol !== 'https:' || url.href !== url.origin + '/') {
    throw new Error('FILE_ROOM_SITE_URL must be an HTTPS origin, such as https://files.example.com');
  }
  return url.origin;
}

function renderPage(html: string, i18n: I18n, page: SitePage, origin?: string): string {
  const { locale, t } = i18n;
  const guideLink = <a href={pagePath(locale, 'guide')}>{t('viewGuide')}</a>;
  const metadata = pageMetadata(i18n, page, origin).map(({ tag, attrs, text }) =>
    renderToStaticMarkup(createElement(tag, { ...attrs, 'data-page-meta': '' }, text))).join('\n    ');
  html = html.replace('<html lang="zh-CN">', `<html lang="${locale}" dir="${direction(locale)}">`)
    .replace('</head>', () => '  ' + metadata + '\n  </head>');
  if (page === 'home') return html.replace('<!--home-->', () => renderToString(
    <I18nContext.Provider value={i18n}><Home guideOrigin={origin} /></I18nContext.Provider>,
  )).replace('<!--noscript-->', () => renderToStaticMarkup(
    <noscript><p className="shell noscript-note notice">{withMarkup(t('homeNoscript'), { guide: guideLink })}</p></noscript>,
  ));
  if (page === 'room') return html.replace('<!--noscript-->', () => renderToStaticMarkup(
    <noscript><p className="shell noscript-note notice">{t('roomNoscript')} <a href={pagePath(locale)}>{t('backHome')}</a></p></noscript>,
  ));
  return html.replace('<!--content-->', () => renderToStaticMarkup(
    <I18nContext.Provider value={i18n}>{page === 'guide' ? <Guide /> : <NotFound />}</I18nContext.Provider>,
  ));
}

export function publicPages(origin?: string): Plugin {
  const sitemap = origin ? [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...publicEntries.map(({ path }) => '  <url><loc>' + origin + path + '</loc></url>'),
    '</urlset>',
    '',
  ].join('\n') : undefined;
  const robots = 'User-agent: *\nAllow: /\n' + (sitemap ? '\nSitemap: ' + origin + '/sitemap.xml\n' : '');
  const languages = new Map<Locale, Promise<I18n>>();
  function i18n(locale: Locale) {
    const cached = languages.get(locale);
    if (cached) return cached;
    const loaded = loadI18n(locale);
    languages.set(locale, loaded);
    return loaded;
  }

  return {
    name: 'file-room-public-pages',
    async transformIndexHtml(html, { path, server }) {
      if (!server) return;
      const root = server.config.root;
      // The Workers asset handler supplies an absolute filename in development.
      const filePath = path.startsWith(root + '/') ? path.slice(root.length) : path;
      const entry = publicByFile.get(filePath);
      if (entry) return renderPage(html, await i18n(entry.locale), entry.page, origin);
      const fallback = privateEntries.find(({ file }) => filePath === '/' + file);
      if (fallback) return renderPage(html, await i18n(defaultLocale), fallback.page);
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.method !== 'GET' && request.method !== 'HEAD') return next();
        const [path, query] = request.url?.split(/\?(.*)/s) ?? [];
        if (path === '/robots.txt' || (path === '/sitemap.xml' && sitemap)) {
          response.setHeader('Content-Type', path === '/robots.txt' ? 'text/plain; charset=utf-8' : 'application/xml; charset=utf-8');
          response.end(request.method === 'GET' ? path === '/robots.txt' ? robots : sitemap : undefined);
          return;
        }

        // Vite uses the two source HTML pages for assets, including React Refresh in development.
        const entry = publicEntries.find(({ locale, path: route, file }) => locale !== defaultLocale &&
          (path === route || path === route.replace(/\/$/, '') || path === route + '/' || path === '/' + file));
        if (!entry) return next();
        if (path !== entry.path) {
          response.writeHead(301, { Location: entry.path + (query ? '?' + query : '') });
          response.end();
          return;
        }
        try {
          const template = await readFile(join(server.config.root, entry.template), 'utf8');
          const html = await server.transformIndexHtml('/' + entry.file, template, request.url);
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.end(request.method === 'GET' ? html : undefined);
        } catch (error) { next(error); }
      });
    },
    generateBundle: {
      order: 'post',
      async handler(_, bundle) {
        if (this.environment.name !== 'client') return;
        // Compose the language variants after Vite has resolved the hashed asset URLs.
        const files = [...publicEntries, ...privateEntries.map((entry) => ({
          ...entry, template: entry.file, locale: defaultLocale,
        }))];
        const templates = new Map(files.map(({ template }) => {
          const asset = bundle[template];
          if (asset?.type !== 'asset' || typeof asset.source !== 'string') throw new Error('Missing template ' + template);
          return [template, asset.source];
        }));
        for (const { file, template, locale, page } of files) {
          const source = renderPage(templates.get(template)!, await i18n(locale), page, origin);
          const asset = bundle[file];
          if (asset?.type === 'asset') asset.source = source;
          else this.emitFile({ type: 'asset', fileName: file, source });
        }
        this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robots });
        if (sitemap) this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemap });
      },
    },
  };
}
