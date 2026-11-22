import { languageKey, setLocale, t } from './i18n.js';
import { announce, changes, messageFor, shell } from './bridge.js';
import { mountShelf } from './shelf.js';

try { setLocale(localStorage.getItem(languageKey)); } catch { /* Use the default language. */ }
mountShelf('#', {
  announce, changes, messageFor,
  saveLanguage: value => localStorage.setItem(languageKey, value),
});

function connection() {
  document.getElementById('offline-state').textContent = navigator.onLine ? t('offlineReady') : t('offlineReading');
}
shell.then(() => {
  connection();
  window.addEventListener('online', connection);
  window.addEventListener('offline', connection);
}, error => {
  document.getElementById('offline-state').textContent = t('offlineUnavailable');
  const notice = document.getElementById('notice');
  notice.textContent = messageFor(error);
  notice.hidden = false;
});
