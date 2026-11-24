import React from 'react';
import { useI18n } from './i18n.tsx';

export function SiteFooter(): React.JSX.Element {
  const { t } = useI18n();
  return <footer className="site-footer shell">
    <span lang="en">© 2026 iPocket Studio</span>
    <a href="https://ipocket.xyz/" target="_blank" rel="noopener noreferrer"
      aria-label={t('footerWebsite')}>ipocket.xyz</a>
  </footer>;
}
