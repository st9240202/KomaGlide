import { t } from './i18n.js';
import { putPage, lookupPage } from './store.js';

async function prepareShell() {
  if (!navigator.serviceWorker) throw new Error(t('offlineRequiresSecure'));
  const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
  if (!registration.active) {
    const first = registration.installing || registration.waiting;
    if (!first) throw new Error(t('offlineSetupFailed'));
    await new Promise((resolve, reject) => {
      function check() {
        if (first.state === 'activated') resolve();
        else if (first.state === 'redundant') reject(new Error(t('offlineInstallFailed')));
        else return;
        first.removeEventListener('statechange', check);
      }
      first.addEventListener('statechange', check);
      check();
    });
  }
  return registration;
}

export const shell = Promise.resolve().then(prepareShell);
shell.catch(() => {}); // Observed separately by the UI and individual transfer requests.

export const changes = new EventTarget();
const tabs = new BroadcastChannel('komaglide-library-changes-v1');
tabs.onmessage = event => changes.dispatchEvent(new CustomEvent('change', { detail: event.data }));
export function announce(detail) {
  changes.dispatchEvent(new CustomEvent('change', { detail }));
  tabs.postMessage(detail);
}

export function messageFor(error) {
  if (error?.name === 'QuotaExceededError') return t('quotaExceeded');
  return error?.message || t('offlineAccessFailed');
}

window.addEventListener('message', async event => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data;
  if (data?.channel !== 'komaglide-library-v1' || typeof data.id !== 'string' ||
      !['put', 'has', 'get', 'ping'].includes(data.op)) return;
  const reply = { channel: 'komaglide-library-result-v1', id: data.id };
  try {
    if (data.op === 'put') {
      await shell;
      await putPage(data.page, data.blob);
      announce({ kind: 'saved', site: data.page.site, workId: data.page.workId || '', chapterId: data.page.chapterId });
    } else if (data.op === 'ping') {
      await shell;
    } else {
      Object.assign(reply, await lookupPage(data.page, data.op === 'get'));
    }
    reply.ok = true;
  } catch (error) {
    reply.ok = false;
    reply.error = messageFor(error);
    if (data.op === 'put') announce({ kind: 'error', message: reply.error });
  }
  window.postMessage(reply, location.origin);
});
