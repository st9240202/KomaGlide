let shelfEvents;

function getShelfEvents() {
  if (shelfEvents) return shelfEvents;
  const changes = new EventTarget();
  let channel;
  try {
    channel = new BroadcastChannel('komaglide-site-shelf-v1');
  } catch { /* A shelf opened later still reads the saved pages directly. */ }
  const dispatch = detail => changes.dispatchEvent(new CustomEvent('change', {detail}));
  if (channel) channel.onmessage = ({data}) => {
    if (typeof data?.kind === 'string') dispatch(data);
  };
  shelfEvents = {
    changes,
    announce(detail) {
      dispatch(detail);
      channel?.postMessage(detail);
    },
    messageFor(error) {
      return error?.name === 'QuotaExceededError'
        ? t('quotaExceeded')
        : error?.message || t('libraryAccessFailed');
    }
  };
  return shelfEvents;
}

function notifyPageSaved({site, workId, chapterId, index}, evicted) {
  getShelfEvents().announce({kind: 'saved', site, workId, chapterId, index, evicted});
}
