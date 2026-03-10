// CliDeck bridge plugin for OpenCode
// Forwards session events to CliDeck server via HTTP POST.
// Install: copy to ~/.config/opencode/plugins/clideck-bridge.js

const CLIDECK_URL = "http://localhost:4000/opencode-events";

function post(payload) {
  fetch(CLIDECK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

export const CliDeckBridge = async () => {
  return {
    event: async ({ event }) => {
      const t = event.type;
      if (t.startsWith("session.") || t.startsWith("message.")) {
        post({ event: t, ...event.properties });
      }
    },
  };
};
