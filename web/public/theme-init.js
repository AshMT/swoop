/* global localStorage, window, document */
// Sets the theme class before first paint so a dark-mode user never sees a
// white flash while the React bundle loads.
try {
  var stored = localStorage.getItem('swoop_theme');
  var dark =
    stored === 'dark' ||
    ((!stored || stored === 'system') && window.matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) {
    document.documentElement.classList.add('dark');
    document.documentElement.style.colorScheme = 'dark';
  }
} catch {
  /* storage blocked — fall back to the light theme */
}
