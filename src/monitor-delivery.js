const { createSessionDelivery } = require('./session-delivery');

function createMonitorDelivery(server, now = Date.now) {
  const deliver = createSessionDelivery(server, now);
  return (monitor, context) => {
    const label = monitor.name.replace(/[\s\p{Cc}\p{Bidi_Control}]+/gu, ' ').trim() || 'Monitor';
    const name = label.length > 40 ? label.slice(0, 39).trimEnd() + '…' : label;
    const summary = (monitor.pending.summary || 'New finding').replace(/\.$/, '');
    return deliver(monitor, { ...context,
      message: `${name} · ${summary} · clideck monitor read ${monitor.pending.id}`,
    });
  };
}

module.exports = { createMonitorDelivery };
