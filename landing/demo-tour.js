(() => {
  const frame = document.getElementById('demo-frame');
  const container = document.getElementById('demo-container');
  const title = document.getElementById('guide-title');
  const copy = document.getElementById('guide-copy');
  const back = document.getElementById('guide-back');
  const next = document.getElementById('guide-next');
  const expand = document.getElementById('expand-demo');
  const steps = [
    ['A change is ready to try.', 'Your agent has made a clearer Today view for Garden Notes. Choose Allow to open it in Preview. Choose Deny and nothing starts.', 'Conversations'],
    ['Try the result yourself.', 'Mark Basil watered in Preview. The progress changes immediately. Try Needs water to see how the list responds. On a narrow screen, close Preview to return to the conversation.', 'Conversations'],
    ['Keep the next request with the project.', 'Open notes.md in Files, choose Source, change the next step, then Save. Your draft stays with you as you move between views.', 'Files'],
    ['Turn a review into a repeatable step.', 'Choose Review before sharing, then Save and run. The sample result shows the saved brief it read; no AI model is called.', 'Workflows'],
    ['Carry the conversation forward.', 'Return to the Garden Notes conversation. Open the agent picker below the message box, choose Codex, then Switch. The earlier messages stay in place.', 'Conversations'],
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
      copy.textContent = 'Open the Garden Notes sample project. See the recent change, current branch and files, then choose Resume and show me the app.';
      document.querySelectorAll('[data-demo-action]').forEach(other => other.setAttribute('aria-pressed', String(other === b)));
    } else show(action === 'Files' ? 2 : action === 'Workflows' ? 3 : 0);
  }));
  window.addEventListener('message', event => {
    if (event.source !== frame.contentWindow || event.data?.source !== 'cockpit-demo') return;
    const { kind, detail } = event.data;
    if (kind === 'preview') show(1, false);
    if (kind === 'plant-watered') { title.textContent = 'You tried the change.'; copy.textContent = detail + ' is marked watered, and the progress changed in the app. Now open Files to shape the next step.'; }
    if (kind === 'approval') show(0, false);
    if (kind === 'denied') { title.textContent = 'Your call. Nothing started.'; copy.textContent = 'Ask to open the app in the message box to request approval again, or reset the demo.'; }
    if (kind === 'saved') { title.textContent = 'Your next step is saved.'; copy.textContent = 'Now run Review before sharing in Workflows. It reads the saved version of ' + detail + '.'; }
    if (kind === 'workflow') { title.textContent = 'Your review has a conversation.'; copy.textContent = 'It shows the project brief you saved and a fixed sample review. In the Mac app, your chosen agent would do the work.'; }
    if (kind === 'handoff') { title.textContent = 'Same thread. Now using ' + (detail === 'codex' ? 'Codex' : detail) + '.'; copy.textContent = 'Your messages and decisions are still here. In the Mac app, the next agent receives the transcript as context.'; }
    if (kind === 'native') { title.textContent = 'In the installed app'; copy.textContent = detail; }
    if (kind === 'escape') expanded(false);
  });
  frame.srcdoc = JSON.parse(document.getElementById('cockpit-demo').textContent);
})();
