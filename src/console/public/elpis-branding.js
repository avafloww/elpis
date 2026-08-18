(() => {
  const app = document.getElementById('app');
  const favicon = document.querySelector('link[data-elpis-favicon]');

  if (!(app instanceof HTMLElement) || !(favicon instanceof HTMLLinkElement)) {
    return;
  }

  const syncFavicon = () => {
    const theme = app.dataset.theme === 'dark' ? 'dark' : 'light';
    const nextHref = `./elpis-icon-${theme}.svg`;

    if (favicon.getAttribute('href') !== nextHref) {
      favicon.setAttribute('href', nextHref);
    }
  };

  syncFavicon();
  new MutationObserver(syncFavicon).observe(app, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
})();
