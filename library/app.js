import { announce, changes, messageFor, shell } from './bridge.js';
import { mountShelf } from './shelf.js';

mountShelf('#', { announce, changes, messageFor });

function connection() {
  document.getElementById('offline-state').textContent = navigator.onLine ? '可離線開啟' : '離線閱讀中';
}
shell.then(() => {
  connection();
  window.addEventListener('online', connection);
  window.addEventListener('offline', connection);
}, error => {
  document.getElementById('offline-state').textContent = '離線介面尚未就緒';
  const notice = document.getElementById('notice');
  notice.textContent = messageFor(error);
  notice.hidden = false;
});
