(() => {
  const frame = document.getElementById('demo-frame');
  const container = document.getElementById('demo-container');
  const title = document.getElementById('guide-title');
  const copy = document.getElementById('guide-copy');
  const back = document.getElementById('guide-back');
  const next = document.getElementById('guide-next');
  const expand = document.getElementById('expand-demo');
  const steps = [
    ['Your agent is waiting for your decision.', 'Choose Allow in the conversation to open the sample app. Or choose Deny: nothing starts until you say so.', 'Conversations'],
    ['Try the app beside the conversation.', 'Press Count a launch in Preview. This is the same sample that ships with Cockpit. On a narrow screen, close Preview to return to the conversation.', 'Conversations'],
    ['Keep the brief with the build.', 'Open notes.md in Files, choose Source, change a line, then Save. Your edit stays when you switch views.', 'Files'],
    ['Turn a useful routine into a workflow.', 'Choose Review the next step, then Save and run. Its conversation opens with your saved notes and a sample checklist.', 'Workflows'],
    ['Different agent. Same conversation.', 'Go back to the theme conversation. Open the agent picker below the message box, choose Codex, then Switch. The existing conversation stays with you.', 'Conversations'],
  ];
  let step = 0;
  function send(action) { frame.contentWindow?.postMessage({ source: 'cockpit-tour', action }, '*'); }
  function show(index, navigate = true) {
    step = index;
    const item = steps[index];
    title.textContent = String(index + 1).padStart(2, '0') + ' / ' + item[0];
    copy.textContent = item[1];
    back.disabled = index === 0;
    next.textContent = index === steps.length - 1 ? 'Start again ↺' : 'Next →';
    document.querySelectorAll('[data-demo-action]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.demoAction === item[2])));
    if (navigate) send(item[2]);
  }
  function expanded(value) {
    container.classList.toggle('expanded', value);
    document.body.classList.toggle('demo-expanded', value);
    expand.setAttribute('aria-expanded', String(value));
    expand.textContent = value ? 'Close expanded view ×' : 'Expand ↗';
    if (!value) expand.focus({ preventScroll: true });
  }
  expand.addEventListener('click', () => expanded(!container.classList.contains('expanded')));
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && container.classList.contains('expanded')) expanded(false); });
  document.getElementById('reset-demo').addEventListener('click', () => { send('reset'); show(0, false); });
  back.addEventListener('click', () => show(Math.max(0, step - 1)));
  next.addEventListener('click', () => { if (step === steps.length - 1) { send('reset'); show(0, false); } else show(step + 1); });
  document.querySelectorAll('[data-demo-action]').forEach(b => b.addEventListener('click', () => {
    const action = b.dataset.demoAction;
    if (action === 'recovery') {
      send(action); title.textContent = 'Pick up recent work.';
      copy.textContent = 'Choose Open a project to open the sample folder. Cockpit finds the recent conversation and changed files. Then choose Resume and show me the app.';
      document.querySelectorAll('[data-demo-action]').forEach(other => other.setAttribute('aria-pressed', String(other === b)));
    } else show(action === 'Files' ? 2 : action === 'Workflows' ? 3 : 0);
  }));
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.data?.source !== 'cockpit-demo') return;
    const { kind, detail } = event.data;
    if (kind === 'preview') show(1, false);
    if (kind === 'approval') show(0, false);
    if (kind === 'denied') { title.textContent = 'Your call. Nothing started.'; copy.textContent = 'Send “start the app” in the message box to request approval again, or reset the demo.'; }
    if (kind === 'saved') { title.textContent = 'Saved: ' + detail; copy.textContent = 'Now choose Workflows and run Review the next step. It reads the saved version of notes.md.'; }
    if (kind === 'workflow') { title.textContent = 'Your workflow has a conversation.'; copy.textContent = 'Here are the notes you saved and the fixed sample checklist. The workflow stays in Workflows for another run.'; }
    if (kind === 'handoff') { title.textContent = 'Same thread. Now using ' + (detail === 'codex' ? 'Codex' : detail) + '.'; copy.textContent = 'Your messages and decisions are still here. In the Mac app, the next agent receives the transcript as context.'; }
    if (kind === 'native') { title.textContent = 'In the installed app'; copy.textContent = detail; }
    if (kind === 'escape') expanded(false);
  });
  frame.srcdoc = JSON.parse(document.getElementById('cockpit-demo').textContent);
})();
