(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const number = n => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(n);
  const money = n => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < 1 ? 3 : 2 }).format(n);
  const date = key => new Date(key + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const node = (tag, text, cls) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el; };
  let days = 30, visible = true, timer, deadline, requestId = '', report, selectedDay = '', sessionSignature = '';
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  function refresh() {
    clearTimeout(deadline); requestId = crypto.randomUUID(); $('refresh').disabled = true;
    parent.postMessage({ type: 'clideck.send', event: 'request', data: { action: 'usage', requestId, filters: { days, timeZone, sessionId: $('session').value } } }, '*');
    deadline = setTimeout(() => { requestId = ''; $('refresh').disabled = false; $('error').textContent = 'Usage did not load. Check your connection and try Refresh.'; $('error').hidden = false; }, 12000);
  }
  function polling() { clearInterval(timer); if (visible) { refresh(); timer = setInterval(() => { if (!requestId) refresh(); }, 5000); } else { clearTimeout(deadline); requestId = ''; $('refresh').disabled = false; } }
  function tableRow(label, item, hint) {
    const row = node('tr'), name = node('td', label); if (hint) name.append(node('small', hint));
    row.append(name, node('td', number(item.seconds / 60)), node('td', money(item.usd))); return row;
  }
  function render(data) {
    report = data; const t = data.totals;
    $('error').hidden = !data.error; $('error').textContent = data.error || '';
    $('minutes').textContent = number(t.seconds / 60); $('cost').textContent = money(t.usd); $('count').textContent = String(t.connections);
    $('active').textContent = t.active ? `${t.active} active now` : 'Each connection counts once';
    $('cost-note').textContent = t.estimatedSeconds ? 'Includes provisional duration' : 'Based on provider-reported duration';
    $('updated').textContent = 'Updated ' + new Date(data.updatedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    $('uncertain').hidden = !t.unknown;
    $('uncertain').textContent = `${t.unknown} connection${t.unknown === 1 ? '' : 's'} could not be confirmed. Their unknown costs are excluded, so the total may be higher.`;
    $('empty').hidden = t.connections > 0; $('dashboard').hidden = !t.connections; $('daily-details').hidden = !t.connections;
    const signature = JSON.stringify(data.availableSessions);
    if (signature !== sessionSignature) {
      sessionSignature = signature; const value = $('session').value;
      const all = node('option', 'All sessions'); all.value = '';
      $('session').replaceChildren(all, ...data.availableSessions.map(s => { const o = node('option', s.name); o.value = s.id; return o; })); $('session').value = value;
    }
    $('sessions').replaceChildren(...data.sessions.map(s => tableRow(s.name, s, s.estimatedSeconds ? `${number(s.estimatedSeconds / 60)} min provisional` : 'Provider-reported duration')));
    $('daily').replaceChildren(...[...data.daily].reverse().map(d => tableRow(date(d.day), d)));
    $('breakdown').replaceChildren(...['browser', 'phone'].map(kind => {
      const item = data.breakdown.find(b => b.kind === kind) || { seconds: 0, usd: 0 };
      const row = node('div', undefined, 'breakdown-row'), label = node('span', kind === 'browser' ? 'Talk to sessions' : 'Phone-call voice');
      label.append(node('small', `${number(item.seconds / 60)} minutes`)); row.append(label, node('strong', money(item.usd))); return row;
    }));
    $('breakdown-total').textContent = money(t.usd); $('rate').textContent = `${money(data.rate.usdPerMinute)} / min`;
    $('basis').textContent = `${number(t.reportedSeconds / 60)} min reported by OpenAI · ${number(t.estimatedSeconds / 60)} min provisional. Waiting and silence count while connected. Provisional browser usage includes the 15-second initialization charge; it is not added again to final reported usage.`;
    $('verified').textContent = `Rate checked ${data.rate.checkedAt}.`;
    $('since').textContent = `Tracking since ${new Date(data.since).toLocaleDateString()}. Earlier use and sample-generation costs are not included. Bundled voice previews are free to play.`;
    $('timezone').textContent = `Days use ${data.timeZone}. Connections spanning midnight are split across days.`;
    drawChart();
  }
  function drawChart() {
    const data = report, fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const today = fmt.format(data.updatedAt), length = days === 7 ? 7 : 30;
    const points = Array.from({ length }, (_, i) => {
      const key = new Date(Date.parse(today + 'T00:00:00Z') - (length - i - 1) * 86400000).toISOString().slice(0, 10);
      return data.daily.find(d => d.day === key) || { day: key, seconds: 0, usd: 0 };
    });
    const max = Math.max(60, ...points.map(p => p.seconds));
    $('chart-range').textContent = `Last ${length} days · minutes`;
    $('chart').replaceChildren(...points.map(item => {
      const label = `${date(item.day)} · ${number(item.seconds / 60)} min · ${money(item.usd)} estimated`;
      const bar = node('button', undefined, 'bar' + (!item.seconds ? ' zero' : '')); bar.type = 'button';
      bar.style.height = Math.max(3, item.seconds / max * 100) + '%'; bar.title = label;
      bar.setAttribute('aria-label', label); bar.setAttribute('aria-pressed', String(selectedDay === item.day));
      bar.onclick = () => { selectedDay = item.day; $('day-detail').textContent = label; for (const other of $('chart').children) other.setAttribute('aria-pressed', String(other === bar)); };
      if (selectedDay === item.day) $('day-detail').textContent = label;
      return bar;
    }));
    $('first-day').textContent = date(points[0].day); $('last-day').textContent = date(today);
  }
  for (const button of document.querySelectorAll('[data-days]')) button.onclick = () => {
    days = Number(button.dataset.days); selectedDay = ''; $('day-detail').textContent = 'Select a day to see its time and estimated cost.';
    for (const b of document.querySelectorAll('[data-days]')) b.setAttribute('aria-pressed', String(b === button)); refresh();
  };
  $('session').onchange = refresh; $('refresh').onclick = refresh;
  $('pricing').onclick = event => { event.preventDefault(); parent.postMessage({ type: 'clideck.open', url: 'https://developers.openai.com/api/docs/pricing' }, '*'); };
  window.addEventListener('message', event => {
    if (event.source !== parent) return;
    const m = event.data || {}, d = m.data || {};
    if (m.type === 'clideck.init') { visible = d.visible !== false; if (['dark','light'].includes(d.theme)) document.documentElement.dataset.theme = d.theme; polling(); }
    else if (m.type === 'clideck.theme' && ['dark','light'].includes(d.theme)) document.documentElement.dataset.theme = d.theme;
    else if (m.type === 'clideck.visible') { visible = d.visible !== false; polling(); }
    else if (m.type === 'clideck.message' && d.event === 'result' && d.data?.requestId === requestId) {
      clearTimeout(deadline); requestId = ''; $('refresh').disabled = false;
      if (d.data.ok && d.data.usage) render(d.data.usage);
      else { $('error').textContent = d.data.error || 'Usage could not load. Try Refresh.'; $('error').hidden = false; }
    }
  });
  window.addEventListener('pagehide', () => { clearInterval(timer); clearTimeout(deadline); });
  parent.postMessage({ type: 'clideck.ready' }, '*');
})();
