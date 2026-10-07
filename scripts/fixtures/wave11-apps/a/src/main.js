import { msg } from './msg.js'
document.getElementById('msg').textContent = msg
fetch('/api/state').then((r) => r.json()).then((s) => { document.getElementById('state').textContent = s.loggedIn ? `logged in, count ${s.count}` : 'not logged in' })
const es = new EventSource('/events'); let n = 0
es.onmessage = () => { document.getElementById('sse').textContent = String(++n) }
if (import.meta.hot) import.meta.hot.accept('./msg.js', (m) => { document.getElementById('msg').textContent = m.msg })
