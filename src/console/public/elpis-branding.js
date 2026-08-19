(() => {
  const app = document.getElementById('app');
  const favicon = document.querySelector('link[data-elpis-favicon]');
  const themeColor = document.querySelector('meta[data-elpis-theme-color]');

  if (!(app instanceof HTMLElement) || !(favicon instanceof HTMLLinkElement) || !(themeColor instanceof HTMLMetaElement)) {
    return;
  }

  const syncBranding = () => {
    const theme = app.dataset.theme === 'dark' ? 'dark' : 'light';
    const nextHref = `./elpis-icon-${theme}.svg`;
    const nextThemeColor = theme === 'dark' ? '#141320' : '#e7ece4';

    if (favicon.getAttribute('href') !== nextHref) {
      favicon.setAttribute('href', nextHref);
    }
    if (themeColor.content !== nextThemeColor) {
      themeColor.content = nextThemeColor;
    }
  };

  syncBranding();
  new MutationObserver(syncBranding).observe(app, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
})();
