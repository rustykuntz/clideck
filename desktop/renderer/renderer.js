// Startup / error screen for the desktop shell. It only renders the shell's state: the shell starts or reuses the
// engine and navigates this window to the app once the engine is ready.
(function () {
  const desk = window.clideckDesktop;
  const $ = (id) => document.getElementById(id);
  const stage = $("stage"), sub = $("sub"), problem = $("problem"), error = $("error");
  const retry = $("retry"), logs = $("logs"), quit = $("quit"), copy = $("copy");
  let logPath = "", revealTimer = null;

  // A fast start should feel instant: the status line and progress appear only if starting takes a moment.
  revealTimer = setTimeout(() => sub.classList.add("show"), 450);

  function render(state) {
    if (!state || typeof state !== "object") return;
    if (state.capabilities && state.capabilities.vibrancy) document.documentElement.classList.add("vibrancy");
    if (state.version) $("version").textContent = "Version " + state.version;
    const engine = state.engine || {}, st = String(engine.state || "starting");
    logPath = engine.logPath || "";
    const failed = st === "error";
    stage.dataset.state = failed ? "error" : "starting";
    problem.hidden = !failed;
    if (failed) {
      clearTimeout(revealTimer); sub.classList.add("show");
      $("title").textContent = "CliDeck couldn’t start";
      sub.textContent = "The engine isn’t answering. Your saved sessions are safe.";
      error.textContent = engine.error ? String(engine.error) : "";
      logs.hidden = !(logPath && desk && desk.showItemInFolder);
      retry.disabled = false;
      if (!problem.contains(document.activeElement)) retry.focus();
    } else {
      $("title").textContent = "CliDeck";
      sub.textContent = st === "reconnecting" ? "Connecting to your running engine…" : st === "ready" ? "Opening…" : "Starting the engine…";
    }
  }

  retry.addEventListener("click", () => {
    if (!desk || !desk.retryEngine) return;
    retry.disabled = true;
    render({ engine: { state: "starting" } });
    Promise.resolve(desk.retryEngine()).catch(() => { retry.disabled = false; });
  });
  logs.addEventListener("click", () => { if (logPath && desk) desk.showItemInFolder(logPath); });
  quit.addEventListener("click", () => { if (desk && desk.quit) desk.quit(); else window.close(); });
  copy.addEventListener("click", () => {
    const text = error.textContent; if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      copy.classList.add("done"); copy.title = "Copied";
      setTimeout(() => { copy.classList.remove("done"); copy.title = "Copy details"; }, 1400);
    }).catch(() => {});
  });

  if (!desk) { render({ engine: { state: "error", error: "This page runs inside the CliDeck desktop app." } }); return; }
  if (typeof desk.onState === "function") desk.onState(render);
  Promise.resolve(desk.getState && desk.getState()).then(render).catch(() => {});
})();
