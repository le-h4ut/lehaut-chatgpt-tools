/* No analytics, extension probing, cookies or persistent storage. */
(() => {
  'use strict';
  const config = window.LEHAUT_CONFIG;
  if (!config || !Array.isArray(config.scripts) || config.scripts.length !== 3) return;
  const byId = new Map(config.scripts.map(script => [script.id, script]));
  document.querySelectorAll('[data-version]').forEach(el => {
    const script = byId.get(el.dataset.version);
    if (script) el.textContent = script.version;
  });
  document.querySelectorAll('[data-install]').forEach(el => {
    const script = byId.get(el.dataset.install);
    if (script) el.href = script.url;
  });
  document.querySelectorAll('[data-repo]').forEach(el => { el.href = config.repositoryUrl; });
  document.querySelectorAll('[data-readme]').forEach(el => { el.href = `${config.repositoryUrl}#readme`; });
  const command = document.getElementById('install-command');
  command.textContent = config.command;
  const copy = document.getElementById('copy-command');
  copy.hidden = false;
  copy.addEventListener('click', async () => {
    const status = document.getElementById('copy-status');
    try {
      await navigator.clipboard.writeText(config.command);
      status.textContent = 'Copied. Paste into PowerShell.';
    } catch {
      const range = document.createRange();
      range.selectNodeContents(command);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      status.textContent = 'Select and copy the command above (Ctrl+C, or press and hold).';
    }
  });

  const descriptions = {
    fixpack: ['ChatGPT Le_Haut Fixpack', 'Full history and Markdown improvements for desktop. Optional on mobile.'],
    search: ['ChatGPT Message Search', 'Search the full conversation and jump to older messages. Works on desktop and Firefox Android.'],
    exporter: ['ChatGPT RP Exporter GUI', 'Save your current conversation as RP TXT or RAW JSON. Works on desktop and Firefox Android.']
  };
  const wizard = document.getElementById('wizard');
  const title = document.getElementById('wizard-title');
  const install = document.getElementById('wizard-install');
  const next = document.getElementById('wizard-next');
  const hint = document.getElementById('wizard-hint');
  let queue = [];
  let step = 0;
  let sourceButton;
  function render() {
    const done = step === queue.length;
    document.getElementById('wizard-progress').textContent = done ? 'GUIDE COMPLETE' : `INSTALLATION / ${step + 1} OF ${queue.length}`;
    next.hidden = done;
    install.textContent = done ? 'Open ChatGPT ↗' : 'Open installation ↗';
    install.href = done ? 'https://chatgpt.com/' : byId.get(queue[step]).url;
    title.textContent = done ? 'Your next conversation is ready.' : descriptions[queue[step]][0];
    document.getElementById('wizard-description').textContent = done
      ? 'If you confirmed every installation in Tampermonkey, open ChatGPT or refresh its tab. You can update or remove scripts in the Tampermonkey dashboard.'
      : descriptions[queue[step]][1];
    next.disabled = true;
    next.textContent = step === queue.length - 1 ? "I've installed it — finish" : "I've installed it — next";
    hint.textContent = done ? 'Installation status is based on your confirmations.' : 'Open the installation page first. Return here after confirming it in Tampermonkey.';
    title.focus({ preventScroll: true });
  }
  function start(ids, button) {
    queue = ids;
    step = 0;
    sourceButton = button;
    wizard.hidden = false;
    render();
    wizard.scrollIntoView({ block: 'start' });
  }
  const all = document.getElementById('install-all');
  const mobile = document.getElementById('install-mobile');
  all.hidden = false;
  mobile.hidden = false;
  all.addEventListener('click', () => start(['fixpack', 'search', 'exporter'], all));
  mobile.addEventListener('click', () => start(['search', 'exporter'], mobile));
  install.addEventListener('click', () => {
    if (step < queue.length) {
      next.disabled = false;
      hint.textContent = 'After confirming in Tampermonkey, return here and continue. If the tab did not open, use the individual card below.';
    }
  });
  next.addEventListener('click', () => { if (step < queue.length) { step++; render(); } });
  document.getElementById('close-wizard').addEventListener('click', () => {
    wizard.hidden = true;
    sourceButton?.focus();
  });
})();
