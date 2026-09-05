async function refresh() {
  const r = await chrome.runtime.sendMessage({ type: 'popup_status' }).catch(() => null);
  if (!r) return;
  document.getElementById('email').textContent = r.email || '(no email)';
  document.getElementById('profileName').textContent = r.profileName || '(unknown)';
  document.getElementById('profileId').textContent = r.profileId || '-';
  const s = document.getElementById('status');
  s.textContent = r.connected ? 'connected' : 'disconnected';
  s.className = r.connected ? 'ok' : 'bad';
  document.getElementById('alias').value = r.alias || '';
}

document.getElementById('save').addEventListener('click', async () => {
  const alias = document.getElementById('alias').value.trim();
  await chrome.runtime.sendMessage({ type: 'popup_set_alias', alias });
  await refresh();
});

document.getElementById('reconnect').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'popup_reconnect' });
  setTimeout(refresh, 500);
});

refresh();
setInterval(refresh, 2000);
