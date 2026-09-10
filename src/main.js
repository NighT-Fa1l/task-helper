import "./style.css";

const API = (import.meta.env.VITE_API_URL || "http://localhost:5000").replace(/\/$/, "");
const STORAGE = {
  profile: "task-helper.profile",
  api: "task-helper.ai-config",
  calendar: "task-helper.calendar-events",
  chat: "task-helper.chat",
  classes: "task-helper.classes",
  notes: "task-helper.notes",
  goals: "task-helper.goals",
  reminders: "task-helper.reminders",
  settings: "task-helper.settings"
};

const defaultTasks = [
  { id: crypto.randomUUID(), title: "Finish CS50 problem set", due: "Today · 8:00 PM", priority: "High", done: false },
  { id: crypto.randomUUID(), title: "Review vector analysis notes", due: "Tomorrow · 6:00 PM", priority: "Medium", done: false },
  { id: crypto.randomUUID(), title: "Read chapter 4", due: "Friday · 9:00 PM", priority: "Low", done: false }
];

const state = {
  authenticated: false,
  profile: load(STORAGE.profile, null),
  api: null,
  aiSettings: load("task-helper.ai-settings", {personality:"concise",memory_summary:""}),
  calendar: load(STORAGE.calendar, []),
  classes: load(STORAGE.classes, []),
  notes: load(STORAGE.notes, []),
  documents: [],
  goals: load(STORAGE.goals, []),
  reminders: load(STORAGE.reminders, []),
  settings: load(STORAGE.settings, { notifications: true, theme: "dark" }),
  tasks: load("task-helper.local-tasks", defaultTasks),
  chats: load(STORAGE.chat, []),
  view: "home",
  workspace: { center: "chat", right: "tasks", document: null, focus: "chat" },
  filter: "all",
  calendarToken: null,
  busy: false,
  attachments: [],
  clockTick: 0,
  stopwatch: { running: false, startedAt: null, elapsed: 0 },
  timer: { running: false, endsAt: null, remaining: 0, preset: 25 * 60 },
  activeTimeTool: "clock",
  driveToken: null,
  driveTokenClient: null,
  workspaceLoaded: false
};

function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function save(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }
function initials(user) { return (user?.name || user?.email || "?").split(/\s+/).map(x => x[0]).slice(0,2).join("").toUpperCase(); }
function isBackend() { return Boolean(API && !API.includes("localhost") || location.hostname === "localhost"); }

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, { credentials: "include", ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function boot() {
  try {
    const data = await api("/api/auth/me");
    state.authenticated = true;
    state.profile = data.user;
    save(STORAGE.profile, state.profile);
    await loadTasks();
    await loadWorkspace();
    await loadAccountSettings();
  } catch {
    state.authenticated = false;
  }
  render();
}

async function loadAccountSettings(){
  if(!state.authenticated)return;
  try{const data=await api("/api/account/settings");state.aiSettings=data.settings||state.aiSettings;state.chats=(data.chats||[]).map(x=>({role:x.role,content:x.content}));save("task-helper.ai-settings",state.aiSettings);save(STORAGE.chat,state.chats);}catch(error){console.warn("Could not load account AI data:",error.message);}
}

async function loadTasks() {
  if (!state.authenticated) return;
  try { state.tasks = (await api("/api/tasks")).tasks; } catch { /* local fallback */ }
}

async function loadWorkspace() {
  if (!state.authenticated) return;
  try {
    const data = await api("/api/workspace");
    state.classes = data.classes || [];
    state.notes = data.notes || [];
    state.goals = data.goals || [];
    state.calendar = data.calendar || [];
    state.documents = data.documents || [];
    state.workspaceLoaded = true;
  } catch { /* local fallback */ }
}

async function workspaceSave(resource, payload, id = null) {
  if (!state.authenticated) return null;
  try {
    const path = id ? `/api/${resource}/${id}` : `/api/${resource}`;
    const data = await api(path, { method: id ? "PATCH" : "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(payload) });
    return data.item || data[resource.slice(0,-1)] || data;
  } catch (error) {
    console.warn(`Could not sync ${resource}:`, error.message);
    return null;
  }
}

async function workspaceDelete(resource, id) {
  if (!state.authenticated) return;
  try { await api(`/api/${resource}/${id}`, {method:"DELETE"}); } catch (error) { console.warn(`Could not delete ${resource}:`, error.message); }
}

async function ensureDriveToken() {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if (!clientId || !window.google?.accounts?.oauth2) throw new Error("Google Drive access is not configured in this build.");
  if (state.driveToken) return state.driveToken;
  return await new Promise((resolve, reject) => {
    state.driveTokenClient ||= window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: "https://www.googleapis.com/auth/drive.file",
      callback: response => response?.access_token ? resolve(response.access_token) : reject(new Error(response?.error_description || "Google Drive permission was not granted."))
    });
    state.driveTokenClient.callback = response => response?.access_token ? (state.driveToken = response.access_token, resolve(response.access_token)) : reject(new Error(response?.error_description || "Google Drive permission was not granted."));
    state.driveTokenClient.requestAccessToken({prompt: ""});
  });
}

async function uploadToDrive(file) {
  const token = await ensureDriveToken();
  const form = new FormData();
  form.append("file", file, file.name);
  const response = await fetch(`${API}/api/documents`, {method:"POST", credentials:"include", headers:{"X-Drive-Access-Token":token}, body:form});
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error || "Could not save the file to Google Drive.");
  state.documents = [data.document, ...(state.documents || []).filter(d=>d.id !== data.document.id)];
  return data.document;
}

async function refreshDocumentContent(doc) {
  const token = await ensureDriveToken();
  const response = await fetch(`${API}/api/documents/${doc.id}/content`, {credentials:"include", headers:{"X-Drive-Access-Token":token}});
  if (!response.ok) throw new Error("Could not pull this file from Google Drive.");
  const blob = await response.blob();
  doc.preview = doc.mime?.startsWith("image/") ? URL.createObjectURL(blob) : null;
  doc.file = new File([blob], doc.name, {type:doc.mime || blob.type});
  return doc;
}

async function persistTask(task) {
  save("task-helper.local-tasks", state.tasks);
  if (!state.authenticated) return;
  try {
    if (task.__new) {
      delete task.__new;
      const data = await api("/api/tasks", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify(task) });
      task.id = data.task.id;
    }
  } catch { /* local fallback */ }
}

function render() {
  const active = state.tasks.filter(t => !t.done);
  const visible = active.filter(t => state.filter === "all" || String(t.priority).toLowerCase() === state.filter);
  const center = state.workspace.center;

  document.querySelector("#app").innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand"><span class="brand-mark"><span></span></span><div><strong>Task Helper</strong><small>your intelligent study workspace</small></div></div>
        <div class="top-actions">
          <button class="icon-button" id="commandBtn" title="Command palette">⌘ K</button>
          <button class="icon-button" id="focusBtn" title="Focus mode">Focus</button>
          <button class="avatar" id="accountBtn">${escapeHtml(initials(state.profile))}</button>
        </div>
      </header>

      <main class="workspace ${state.workspace.focus === "focus" ? "focus-mode" : ""}">
        <aside class="sidebar left-sidebar">
          <div class="side-title">WORKSPACE</div>
          ${navButton("home", "⌂", "Home")}
          ${navButton("tasks", "✓", "Tasks", active.length)}
          ${navButton("classes", "▦", "Classes")}
          ${navButton("documents", "▤", "Documents")}
          ${navButton("notes", "✎", "Notes")}
          ${navButton("calendar", "□", "Calendar")}
          ${navButton("goals", "◇", "Goals")}
          <div class="side-title gap">TOOLS</div>
          <button class="side-link" id="newTaskBtn"><span>＋</span> New task</button>
          <button class="side-link" id="uploadBtn"><span>↥</span> Upload material</button>
          <button class="side-link" id="searchBtn"><span>⌕</span> Search</button>
          <div class="side-bottom">
            <button class="side-link" id="settingsBtn"><span>⚙</span> Settings</button>
            <div class="connection ${state.authenticated ? "online" : "offline"}"><i></i>${state.authenticated ? "Account connected" : "Local mode"}</div>
          </div>
        </aside>

        <section class="center-stage">${renderCenter(center, visible)}</section>

        <aside class="right-sidebar">${renderRight()}</aside>
      </main>
      <div id="modalRoot"></div>
      <input id="filePicker" type="file" accept="application/pdf,image/*" multiple hidden>
    </div>`;
  bind();
}

function navButton(view, icon, label, count) {
  return `<button class="side-link ${state.view === view ? "selected" : ""}" data-view="${view}"><span>${icon}</span>${label}${count != null ? `<b>${count}</b>` : ""}</button>`;
}

function renderCenter(center, visible) {
  if (center === "document" && state.workspace.document) return renderDocumentWorkspace();
  if (state.view === "classes") return renderClasses();
  if (state.view === "documents") return renderDocuments();
  if (state.view === "notes") return renderNotes();
  if (state.view === "calendar") return renderCalendar();
  if (state.view === "goals") return renderGoals();
  if (state.view === "tasks") return renderTaskView(visible);
  return renderHome();
}

function renderHome() {
  const today = new Date().toLocaleDateString(undefined, { weekday:"long", month:"long", day:"numeric" });
  return `<div class="stage-header"><div><span class="eyebrow">${today.toUpperCase()}</span><h1>What should we work on?</h1><p>Ask me to organize your tasks, understand your study material, or change this workspace.</p></div><button class="soft-button" id="quickUpload">↥ Add material</button></div>
    <div class="ai-home"><div class="ai-orb"><span></span></div><h2>Task Helper AI</h2><p>Your tasks, classes, notes, calendar and documents — in one conversation.</p>
      <div class="suggestions"><button data-prompt="Organize my tasks for today">Organize my day</button><button data-prompt="What should I study next?">What should I study?</button><button data-prompt="Help me plan this week">Plan my week</button></div>
    </div>
    ${renderChat()}`;
}

function renderChat(compact = false) {
  const messages = state.chats.slice(-20);
  return `<section class="chat-panel ${compact ? "compact" : ""}">
    <div class="chat-head"><div><strong>AI workspace</strong><span>${state.busy ? "Working on it…" : "Ready"}</span></div><button class="text-button" id="clearChat">Clear</button></div>
    <div class="chat-stream" id="chatStream">${messages.length ? messages.map(m => chatMessage(m)).join("") : `<div class="chat-empty"><span>Ask naturally.</span><small>Try “make a study plan from this PDF” or “move my physics task to tomorrow”.</small></div>`}</div>
    ${state.busy ? `<div class="processing"><span class="processing-line"><i></i><i></i><i></i><i></i><i></i></span><span>Analyzing your request${state.attachments.length ? " and attachment" : ""}…</span></div>` : ""}
    <div class="attachment-strip">${state.attachments.map((a,i) => `<div class="attachment-chip"><span>${a.type.startsWith("image/") ? "▧" : "▤"}</span>${escapeHtml(a.name)}<button data-remove-attachment="${i}">×</button></div>`).join("")}</div>
    <form class="chat-composer" id="chatForm"><button type="button" class="attach-button" id="attachBtn">＋</button><textarea id="chatInput" rows="1" placeholder="Ask Task Helper anything…"></textarea><button class="send-button" ${state.busy ? "disabled" : ""}>↑</button></form>
    <div class="composer-hint">AI can read PDFs and images you attach. <span>${state.authenticated ? "Synced to your account" : "Local mode"}</span></div>
  </section>`;
}

function chatMessage(m) { return `<div class="chat-message ${m.role}"><div class="message-label">${m.role === "user" ? "You" : "Task Helper"}</div><div class="message-body">${escapeHtml(m.content)}</div></div>`; }

function renderTaskView(visible) { return `<div class="stage-header"><div><span class="eyebrow">ORGANIZE</span><h1>Tasks</h1><p>Everything that needs your attention, ranked by priority.</p></div><button class="primary-button" id="quickAdd">＋ New task</button></div><div class="filter-row">${["all","high","medium","low"].map(f => `<button class="filter-pill ${state.filter===f?"active":""}" data-filter="${f}">${f[0].toUpperCase()+f.slice(1)}</button>`).join("")}</div><div class="task-list">${visible.length ? visible.map(taskCard).join("") : `<div class="empty-state"><strong>Nothing here.</strong><span>Your attention list is clear.</span></div>`}</div>`; }
function taskCard(t) { return `<article class="task-card ${String(t.priority).toLowerCase()} ${t.done?"done":""}" data-id="${t.id}"><button class="task-check" data-toggle-task="${t.id}">${t.done?"✓":""}</button><div class="task-copy"><strong>${escapeHtml(t.title)}</strong><span>${escapeHtml(t.due || "No due date")}</span></div><span class="priority ${String(t.priority).toLowerCase()}">${escapeHtml(t.priority)}</span><button class="more-button" data-delete-task="${t.id}">•••</button></article>`; }

function renderRight() {
  const active = state.tasks.filter(t => !t.done);
  const high = active.filter(t => t.priority === "High");
  const pct = state.tasks.length ? Math.round(state.tasks.filter(t=>t.done).length / state.tasks.length * 100) : 0;
  const now = new Date();
  const tools = [
    {id:"clock", title:"Clock", display:formatClock(now), meta:"Local time", body:`<div class="time-date">${now.toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"})}</div>`},
    {id:"stopwatch", title:"Stopwatch", display:formatDuration(getStopwatchElapsed()), meta:state.stopwatch.running?"Running":"Ready", body:`<div class="time-actions"><button class="time-button" id="stopwatchToggle">${state.stopwatch.running?"Pause":"Start"}</button><button class="time-button ghost" id="stopwatchReset">Reset</button></div>`},
    {id:"timer", title:"Timer", display:formatDuration(getTimerRemaining()), meta:state.timer.running?"Running":"Ready", body:`<div class="preset-row">${[5,15,25,50].map(m=>`<button class="preset ${state.timer.preset===m*60?"active":""}" data-timer-preset="${m}">${m}m</button>`).join("")}</div><div class="time-actions"><button class="time-button" id="timerToggle">${state.timer.running?"Pause":(getTimerRemaining()>0&&getTimerRemaining()<state.timer.preset?"Resume":"Start")}</button><button class="time-button ghost" id="timerReset">Reset</button></div>`}
  ];
  const tool = tools.find(x=>x.id===state.activeTimeTool) || tools[0];
  const priorityTasks = active.slice().sort((a,b)=>({High:0,Medium:1,Low:2}[a.priority]??3)-({High:0,Medium:1,Low:2}[b.priority]??3)).slice(0,4);
  return `<div class="right-panel time-switcher"><div class="time-switch-head"><button class="switch-arrow" id="timePrev">‹</button><div><div class="panel-kicker">TIME</div><strong>${tool.title}</strong></div><button class="switch-arrow" id="timeNext">›</button></div><div class="time-tool single"><div class="time-display ${tool.id==="clock"?"clock-display":""}" id="activeTimeDisplay">${tool.display}</div><small class="time-status">${tool.meta}</small>${tool.body}</div></div>
    <div class="right-panel task-focus-panel"><div class="panel-head"><div><strong>Tasks to do</strong><span>${active.length} remaining</span></div><button class="text-button" data-view="tasks">View all</button></div><div class="side-task-list">${priorityTasks.map(t=>`<button class="side-task ${String(t.priority).toLowerCase()}" data-side-task="${t.id}"><span class="side-task-check"></span><span class="side-task-copy"><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.due||"No due date")}</small></span><em>${escapeHtml(t.priority||"")}</em></button>`).join("") || `<div class="right-empty">Everything is caught up.</div>`}</div>${active.length>4?`<div class="task-more">+${active.length-4} more in Tasks</div>`:""}</div>
    <div class="right-panel progress-panel"><div class="panel-head"><strong>Progress</strong><span>${pct}%</span></div><div class="progress-track"><i style="width:${pct}%"></i></div><div class="progress-caption">${state.tasks.filter(t=>t.done).length} of ${state.tasks.length} tasks completed</div></div>
    <div class="right-panel upcoming-panel"><div class="panel-head"><strong>Upcoming</strong><button class="text-button" data-view="calendar">View all</button></div>${state.calendar.slice(0,4).map(e=>`<div class="event-row"><span>${eventDay(e.start)}</span><div><strong>${escapeHtml(e.title)}</strong><small>${eventTime(e.start)}</small></div></div>`).join("") || `<div class="right-empty">No upcoming events.</div>`}</div>`;
}

function formatClock(date){return date.toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit",second:"2-digit"});}
function formatDuration(seconds){seconds=Math.max(0,Math.floor(seconds));const h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60),s=seconds%60;return `${h?String(h).padStart(2,"0")+":" : ""}${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;}
function getStopwatchElapsed(){return state.stopwatch.running&&state.stopwatch.startedAt ? state.stopwatch.elapsed + (Date.now()-state.stopwatch.startedAt)/1000 : state.stopwatch.elapsed;}
function getTimerRemaining(){return state.timer.running&&state.timer.endsAt ? Math.max(0,(state.timer.endsAt-Date.now())/1000) : state.timer.remaining;}
function tickTimeTools(){
  state.clockTick++;
  const display=document.querySelector("#activeTimeDisplay");
  if(display && state.activeTimeTool==="clock") display.textContent=formatClock(new Date());
  if(display && state.activeTimeTool==="stopwatch") display.textContent=formatDuration(getStopwatchElapsed());
  if(display && state.activeTimeTool==="timer") display.textContent=formatDuration(getTimerRemaining());
  if(state.timer.running && getTimerRemaining() <= 0){state.timer.running=false;state.timer.endsAt=null;state.timer.remaining=0; render();}
}
function startStopwatch(){if(!state.stopwatch.running){state.stopwatch.running=true;state.stopwatch.startedAt=Date.now();}render();}
function pauseStopwatch(){if(state.stopwatch.running){state.stopwatch.elapsed=getStopwatchElapsed();state.stopwatch.running=false;state.stopwatch.startedAt=null;}render();}
function resetStopwatch(){state.stopwatch={running:false,startedAt:null,elapsed:0};render();}
function startTimer(){const remaining=getTimerRemaining();if(remaining<=0)state.timer.remaining=state.timer.preset;state.timer.endsAt=Date.now()+state.timer.remaining*1000;state.timer.running=true;render();}
function pauseTimer(){if(state.timer.running){state.timer.remaining=getTimerRemaining();state.timer.running=false;state.timer.endsAt=null;}render();}
function resetTimer(){state.timer={running:false,endsAt:null,remaining:state.timer.preset,preset:state.timer.preset};render();}
function setTimerPreset(minutes){state.timer={running:false,endsAt:null,remaining:minutes*60,preset:minutes*60};render();}


function cycleTimeTool(direction){const tools=["clock","stopwatch","timer"];const i=tools.indexOf(state.activeTimeTool);state.activeTimeTool=tools[(i+direction+tools.length)%tools.length];render();}

function miniCalendar() {
  const now=new Date(), y=now.getFullYear(), m=now.getMonth(), first=new Date(y,m,1).getDay(), days=new Date(y,m+1,0).getDate();
  const names=["S","M","T","W","T","F","S"]; let cells=names.map(n=>`<b>${n}</b>`).join("");
  for(let i=0;i<first;i++) cells+="<span class=cal-blank></span>";
  for(let d=1;d<=days;d++){
    const events=state.calendar.filter(e=>{const s=e.start?new Date(e.start):null;return s&&s.getFullYear()===y&&s.getMonth()===m&&s.getDate()===d;});
    const task=state.tasks.some(t=>{const text=String(t.due||"").toLowerCase(); return text.includes(String(d)) && (text.includes("today") || text.includes("tomorrow") || text.includes("jan") || text.includes("feb") || text.includes("mar") || text.includes("apr") || text.includes("may") || text.includes("jun") || text.includes("jul") || text.includes("aug") || text.includes("sep") || text.includes("oct") || text.includes("nov") || text.includes("dec"));});
    const color=events[0]?.color || "#7189ff";
    const style=events.length?`style="--day-color:${escapeHtml(color)}"`:"";
    cells+=`<button class="cal-day ${d===now.getDate()?"today":""} ${events.length?"event":""} ${task?"task-day":""}" ${style} title="${events.map(e=>escapeHtml(e.title)).join(", ")}">${d}</button>`;
  }
  return cells;
}

function eventDay(start){try{return new Date(start).toLocaleDateString(undefined,{weekday:"short"})}catch{return ""}}
function eventTime(start){if(!start)return "All day"; try{return new Date(start).toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"})}catch{return "All day"}}

function renderDocumentWorkspace() { const d=state.workspace.document; return `<div class="document-stage"><div class="document-toolbar"><div><span class="eyebrow">DOCUMENT</span><h1>${escapeHtml(d.name||d.title)}</h1></div><div><button class="soft-button" id="backHome">← Workspace</button><button class="soft-button" id="documentFocus">Focus</button></div></div><div class="document-layout"><div class="document-viewer">${(d.type||d.mime||"").startsWith("image/") ? `<img src="${d.preview}" alt="${escapeHtml(d.name)}">` : `<div class="pdf-placeholder"><div class="pdf-icon">PDF</div><strong>${escapeHtml(d.name)}</strong><span>${d.text ? "Text extracted and ready for AI analysis." : "PDF uploaded. Ask the AI to analyze it."}</span><button class="primary-button" id="analyzeDocument">Analyze with AI</button></div>`}</div><div class="document-chat">${renderChat(true)}</div></div></div>`; }

function renderClasses() { return `<div class="stage-header"><div><span class="eyebrow">STUDY</span><h1>Classes</h1><p>Keep each course connected to its work.</p></div><button class="primary-button" id="addClass">＋ Add class</button></div><div class="class-grid">${state.classes.map(c=>`<article class="class-card"><span class="class-color"></span><h3>${escapeHtml(c.name)}</h3><small>${escapeHtml(c.code||"")}</small><div><span>${c.tasks||0} tasks</span><span>${escapeHtml(c.schedule||"No schedule")}</span></div></article>`).join("") || `<div class="empty-state"><strong>No classes yet.</strong><span>Add your courses so the AI can organize work by class.</span></div>`}</div>`; }
function renderDocuments() { const docs=(state.documents||[]).length?state.documents:state.notes.filter(n=>n.kind==="document"); return `<div class="stage-header"><div><span class="eyebrow">STUDY</span><h1>Documents</h1><p>Your files live in Google Drive; Task Helper keeps the searchable metadata and AI context in PostgreSQL.</p></div><button class="primary-button" id="uploadDocuments">＋ Upload</button></div><div class="document-grid">${docs.map(d=>`<button class="document-card" data-doc="${d.id}"><span class="file-icon">${(d.mime||"").startsWith("image/")?"IMG":"PDF"}</span><strong>${escapeHtml(d.name||d.title)}</strong><small>${escapeHtml(d.meta||d.mime||"AI-ready material")}</small></button>`).join("") || `<div class="empty-state"><strong>Your study library is empty.</strong><span>Upload a PDF or image to store it in your Drive and index it here.</span></div>`}</div>`; }
function renderNotes() { return `<div class="stage-header"><div><span class="eyebrow">STUDY</span><h1>Notes</h1><p>Short, searchable knowledge that stays connected to your workspace.</p></div><button class="primary-button" id="addNote">＋ New note</button></div><div class="notes-grid">${state.notes.filter(n=>n.kind!=="document").map(n=>`<article class="note-card"><small>${escapeHtml(n.created||"Note")}</small><h3>${escapeHtml(n.title)}</h3><p>${escapeHtml(n.body)}</p></article>`).join("") || `<div class="empty-state"><strong>No notes yet.</strong><span>Ask the AI to turn a conversation or document into notes.</span></div>`}</div>`; }
function renderCalendar() { return `<div class="stage-header"><div><span class="eyebrow">PLAN</span><h1>Calendar</h1><p>Your schedule alongside your study workload.</p></div><button class="soft-button" id="addCalendarEvent">＋ Event</button></div><div class="calendar-large"><div class="calendar-large-head"><strong>${new Date().toLocaleDateString(undefined,{month:"long",year:"numeric"})}</strong><span>🔵 Classes &nbsp; 🟣 Events &nbsp; 🟠 Tasks</span></div><div class="large-calendar">${miniCalendar()}</div></div>`; }
function openCalendarEventModal(){showModal("New calendar event",`<form id="eventForm" class="modal-form"><label>Title<input id="eventTitle" required placeholder="Physics quiz"></label><label>Start<input id="eventStart" type="datetime-local" required></label><label>End<input id="eventEnd" type="datetime-local"></label><label>Color<input id="eventColor" type="color" value="#7189ff"></label><button class="primary-button">Add event</button></form>`);document.querySelector("#eventForm").onsubmit=async e=>{e.preventDefault();const item={id:crypto.randomUUID(),title:eventTitle.value,start:new Date(eventStart.value).toISOString(),end:eventEnd.value?new Date(eventEnd.value).toISOString():null,color:eventColor.value};state.calendar.push(item);save(STORAGE.calendar,state.calendar);const saved=await workspaceSave("calendar",item);if(saved)item.id=saved.id;closeModal();render();};}

function renderGoals() { return `<div class="stage-header"><div><span class="eyebrow">DIRECTION</span><h1>Goals</h1><p>Give the AI a destination, not just a list of tasks.</p></div><button class="primary-button" id="addGoal">＋ Add goal</button></div><div class="goal-grid">${state.goals.map(g=>`<article class="goal-card"><div><span class="goal-ring"></span><div><strong>${escapeHtml(g.title)}</strong><small>${escapeHtml(g.target||"")}</small></div></div><div class="goal-progress"><i style="width:${Number(g.progress)||0}%"></i></div><span>${Number(g.progress)||0}%</span></article>`).join("") || `<div class="empty-state"><strong>No goals yet.</strong><span>Try “make passing my physics exam my goal”.</span></div>`}</div>`; }

function bind() {
  document.querySelectorAll("[data-view]").forEach(b => b.onclick = () => { state.view=b.dataset.view; state.workspace.center="chat"; render(); });
  document.querySelectorAll("[data-filter]").forEach(b => b.onclick = () => { state.filter=b.dataset.filter; render(); });
  document.querySelectorAll("[data-toggle-task]").forEach(b => b.onclick = () => toggleTask(b.dataset.toggleTask));
  document.querySelectorAll("[data-delete-task]").forEach(b => b.onclick = () => deleteTask(b.dataset.deleteTask));
  document.querySelectorAll("[data-prompt]").forEach(b => b.onclick = () => { document.querySelector("#chatInput").value=b.dataset.prompt; document.querySelector("#chatInput").focus(); });
  document.querySelectorAll("[data-remove-attachment]").forEach(b => b.onclick = () => { state.attachments.splice(Number(b.dataset.removeAttachment),1); render(); });
  document.querySelectorAll("[data-side-task]").forEach(el=>el.addEventListener("click",async()=>{const id=el.dataset.sideTask;const task=state.tasks.find(t=>t.id===id);if(!task)return;task.done=true;save("task-helper.local-tasks",state.tasks); if(state.authenticated){try{await api(`/api/tasks/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({done:true})})}catch{}} render();}));
  document.querySelector("#timePrev")?.addEventListener("click",()=>cycleTimeTool(-1));
  document.querySelector("#timeNext")?.addEventListener("click",()=>cycleTimeTool(1));
  document.querySelector("#stopwatchToggle")?.addEventListener("click",()=>state.stopwatch.running?pauseStopwatch():startStopwatch());
  document.querySelector("#stopwatchReset")?.addEventListener("click",resetStopwatch);
  document.querySelector("#timerToggle")?.addEventListener("click",()=>state.timer.running?pauseTimer():startTimer());
  document.querySelector("#timerReset")?.addEventListener("click",resetTimer);
  document.querySelectorAll("[data-timer-preset]").forEach(b=>b.onclick=()=>setTimerPreset(Number(b.dataset.timerPreset)));
  document.querySelector("#newTaskBtn")?.addEventListener("click", openTaskModal); document.querySelector("#quickAdd")?.addEventListener("click", openTaskModal);
  document.querySelector("#uploadBtn")?.addEventListener("click", () => document.querySelector("#filePicker").click()); document.querySelector("#quickUpload")?.addEventListener("click", () => document.querySelector("#filePicker").click()); document.querySelector("#uploadDocuments")?.addEventListener("click", () => document.querySelector("#filePicker").click());
  document.querySelector("#filePicker")?.addEventListener("change", e => addAttachments([...e.target.files])); document.querySelector("#attachBtn")?.addEventListener("click", () => document.querySelector("#filePicker").click());
  document.querySelector("#chatForm")?.addEventListener("submit", handleChat); document.querySelector("#chatInput")?.addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();document.querySelector("#chatForm")?.requestSubmit();}}); document.querySelector("#clearChat")?.addEventListener("click", async () => { state.chats=[]; save(STORAGE.chat,state.chats); if(state.authenticated) await api("/api/chat/history",{method:"DELETE"}).catch(()=>{}); render(); });
  document.querySelector("#accountBtn")?.addEventListener("click", () => state.authenticated ? openAccount() : googleSignIn()); document.querySelector("#settingsBtn")?.addEventListener("click", openSettings);
  document.querySelector("#focusBtn")?.addEventListener("click", () => { state.workspace.focus=state.workspace.focus==="focus"?"chat":"focus"; render(); }); document.querySelector("#documentFocus")?.addEventListener("click", () => { state.workspace.focus=state.workspace.focus==="focus"?"chat":"focus"; render(); });
  document.querySelector("#backHome")?.addEventListener("click", () => { state.workspace.document=null; state.workspace.center="chat"; state.view="home"; render(); }); document.querySelector("#analyzeDocument")?.addEventListener("click", analyzeCurrentDocument);
  document.querySelector("#addCalendarEvent")?.addEventListener("click", openCalendarEventModal); document.querySelector("#addClass")?.addEventListener("click", openClassModal); document.querySelector("#addNote")?.addEventListener("click", openNoteModal); document.querySelector("#addGoal")?.addEventListener("click", openGoalModal);
  document.querySelector("#commandBtn")?.addEventListener("click", openCommandPalette); document.querySelector("#searchBtn")?.addEventListener("click", openCommandPalette);
  document.querySelectorAll("[data-doc]").forEach(b => b.onclick = () => openSavedDocument(b.dataset.doc));
}

async function toggleTask(id) { const t=state.tasks.find(x=>x.id===id); if(!t)return; t.done=!t.done; save("task-helper.local-tasks",state.tasks); if(state.authenticated){try{await api(`/api/tasks/${id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({done:t.done})})}catch{}} render(); }
async function deleteTask(id) { state.tasks=state.tasks.filter(t=>t.id!==id); save("task-helper.local-tasks",state.tasks); if(state.authenticated){try{await api(`/api/tasks/${id}`,{method:"DELETE"})}catch{}} render(); }

function openTaskModal() { showModal("New task", `<form id="taskForm" class="modal-form"><label>Task<input id="taskTitle" required placeholder="e.g. Review Gauss's law"></label><label>Due<input id="taskDue" placeholder="Tomorrow · 6:00 PM"></label><label>Priority<select id="taskPriority"><option>High</option><option selected>Medium</option><option>Low</option></select></label><button class="primary-button">Create task</button></form>`); document.querySelector("#taskForm").onsubmit=async e=>{e.preventDefault();const task={id:crypto.randomUUID(),title:document.querySelector("#taskTitle").value.trim(),due:document.querySelector("#taskDue").value||"No due date",priority:document.querySelector("#taskPriority").value,done:false,__new:true};state.tasks.unshift(task);save("task-helper.local-tasks",state.tasks);await persistTask(task);closeModal();render();}; }
function openClassModal(){showModal("Add class",`<form id="classForm" class="modal-form"><label>Class name<input id="className" required placeholder="Physics II"></label><label>Code<input id="classCode" placeholder="PHY 102"></label><label>Schedule<input id="classSchedule" placeholder="Sun / Tue · 10:00 AM"></label><button class="primary-button">Add class</button></form>`);document.querySelector("#classForm").onsubmit=e=>{e.preventDefault();const item={id:crypto.randomUUID(),name:className.value,code:classCode.value,schedule:classSchedule.value,tasks:0,color:"#7189ff"};state.classes.push(item);save(STORAGE.classes,state.classes);workspaceSave("classes",item).then(saved=>{if(saved)item.id=saved.id;});closeModal();render();};}
function openNoteModal(){showModal("New note",`<form id="noteForm" class="modal-form"><label>Title<input id="noteTitle" required placeholder="Important formula"></label><label>Note<textarea id="noteBody" rows="6" placeholder="Write something…"></textarea></label><button class="primary-button">Save note</button></form>`);document.querySelector("#noteForm").onsubmit=e=>{e.preventDefault();const item={id:crypto.randomUUID(),title:noteTitle.value,body:noteBody.value,created:new Date().toLocaleDateString()};state.notes.unshift(item);save(STORAGE.notes,state.notes);workspaceSave("notes",item).then(saved=>{if(saved)item.id=saved.id;});closeModal();render();};}
function openGoalModal(){showModal("Add goal",`<form id="goalForm" class="modal-form"><label>Goal<input id="goalTitle" required placeholder="Pass Physics II"></label><label>Target<input id="goalTarget" placeholder="Midterm · October"></label><button class="primary-button">Add goal</button></form>`);document.querySelector("#goalForm").onsubmit=e=>{e.preventDefault();const item={id:crypto.randomUUID(),title:goalTitle.value,target:goalTarget.value,progress:0};state.goals.push(item);save(STORAGE.goals,state.goals);workspaceSave("goals",item).then(saved=>{if(saved)item.id=saved.id;});closeModal();render();};}

function showModal(title, body) { document.querySelector("#modalRoot").innerHTML=`<div class="modal-backdrop"><div class="modal"><div class="modal-head"><h2>${escapeHtml(title)}</h2><button id="closeModal">×</button></div>${body}</div></div>`;document.querySelector("#closeModal").onclick=closeModal;document.querySelector(".modal-backdrop").onclick=e=>{if(e.target.classList.contains("modal-backdrop"))closeModal();}; }
function closeModal(){document.querySelector("#modalRoot").innerHTML="";}

function openSettings(){showModal("Settings",`<div class="settings-section"><div class="settings-profile"><div class="big-avatar">${escapeHtml(initials(state.profile))}</div><div><strong>${escapeHtml(state.profile?.name||"Google user")}</strong><span>${escapeHtml(state.profile?.email||"")}</span></div></div></div><div class="settings-section"><strong>AI personality</strong><p class="muted">The default is short and practical. Your preference is saved to your Google account workspace.</p><form id="aiSettings" class="modal-form compact-form"><label>Response style<select id="aiPersonality"><option value="concise" ${state.aiSettings.personality==="concise"?"selected":""}>Concise — just what I need</option><option value="balanced" ${state.aiSettings.personality==="balanced"?"selected":""}>Balanced</option><option value="detailed" ${state.aiSettings.personality==="detailed"?"selected":""}>Detailed</option></select></label><label>Saved memory<textarea id="aiMemory" rows="5" placeholder="Preferences or facts for the workspace AI">${escapeHtml(state.aiSettings.memory_summary||"")}</textarea></label><button class="primary-button">Save AI settings</button></form></div><div class="settings-section"><strong>AI provider</strong><p class="muted">The API key is server-side. Never paste an OpenRouter/OpenAI key into this browser app.</p><div class="notice">Provider: ${escapeHtml((state.aiSettings.ai_base_url||"server configured").replace(/^https?:\/\//,""))}<br>Model: ${escapeHtml(state.aiSettings.ai_model||"server default")}</div></div><div class="settings-section"><button class="soft-button full" id="googleSettings">Reconnect Google</button>${state.authenticated?`<button class="danger-button full" id="logoutBtn">Sign out</button>`:""}</div>`); document.querySelector("#aiSettings").onsubmit=async e=>{e.preventDefault();const settings={...state.aiSettings,personality:document.querySelector("#aiPersonality").value,memory_summary:document.querySelector("#aiMemory").value.trim()};if(state.authenticated){try{const data=await api("/api/account/settings",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(settings)});state.aiSettings=data.settings;save("task-helper.ai-settings",state.aiSettings);}catch(err){showModal("Could not save",`<div class="notice error">${escapeHtml(err.message)}</div>`);return;}}else{state.aiSettings=settings;save("task-helper.ai-settings",settings);}closeModal();}; document.querySelector("#googleSettings").onclick=googleSignIn; document.querySelector("#logoutBtn")?.addEventListener("click",logout);}

function openAccount(){showModal("Profile",`<div class="profile-large"><div class="profile-photo">${state.profile?.picture?`<img src="${escapeHtml(state.profile.picture)}">`:escapeHtml(initials(state.profile))}</div><h3>${escapeHtml(state.profile?.name||"Google user")}</h3><span>${escapeHtml(state.profile?.email||"")}</span></div><div class="profile-stats"><div><b>${state.tasks.length}</b><span>Tasks</span></div><div><b>${state.classes.length}</b><span>Classes</span></div><div><b>${state.notes.length}</b><span>Materials</span></div></div><button class="soft-button full" id="profileSettings">Open settings</button>`);document.querySelector("#profileSettings").onclick=openSettings;}

async function googleSignIn(){
  const clientId=import.meta.env.VITE_GOOGLE_CLIENT_ID;
  if(!clientId||!window.google?.accounts?.id){showModal("Google sign-in",`<div class="notice error">Google Identity Services is not configured. Check VITE_GOOGLE_CLIENT_ID and the authorized JavaScript origin in Google Cloud.</div>`);return;}
  showModal("Sign in with Google",`<div class="google-login"><p class="muted">Your Google account loads your workspace, saved AI memory, personality and chat history.</p><div id="googleButton"></div></div>`);
  window.google.accounts.id.initialize({client_id:clientId,callback:async response=>{try{const data=await api("/api/auth/google",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({credential:response.credential})});state.authenticated=true;state.profile=data.user;save(STORAGE.profile,state.profile);await loadTasks();await loadWorkspace();await loadAccountSettings();closeModal();render();}catch(err){showModal("Google sign-in failed",`<div class="notice error">${escapeHtml(err.message)}</div><p class="muted">Check that the frontend and backend use the same Google Web Client ID and that this site's origin is authorized.</p>`);}}});
  window.google.accounts.id.renderButton(document.querySelector("#googleButton"),{theme:"outline",size:"large",shape:"pill",text:"continue_with",width:320});
}

async function logout(){try{await api("/api/auth/logout",{method:"POST"});}catch{}state.authenticated=false;state.profile=null;state.driveToken=null;state.driveTokenClient=null;render();}

async function chooseDocumentFiles(){const input=document.createElement("input");input.type="file";input.accept="application/pdf,image/*";input.multiple=true;input.onchange=async e=>{for(const file of [...e.target.files]){if(file.type!=="application/pdf"&&!file.type.startsWith("image/"))continue;await addUploadedDocument(file);}input.remove();};input.click();}

async function addAttachments(files){ for(const file of files.slice(0,5)){ if(file.size>12*1024*1024){alert(`${file.name} is larger than 12 MB.`);continue;} if(!file.type.startsWith("image/")&&file.type!=="application/pdf")continue; const attachment={id:crypto.randomUUID(),name:file.name,type:file.type,file,preview:file.type.startsWith("image/")?URL.createObjectURL(file):null}; state.attachments.push(attachment); } render(); }

async function handleChat(e){
  e.preventDefault();
  const input=document.querySelector("#chatInput");
  const text=input.value.trim();
  if(!text&&!state.attachments.length)return;
  const attachments=[...state.attachments];
  state.chats.push({role:"user",content:text||"Please analyze these attachments."});
  save(STORAGE.chat,state.chats);
  state.busy=true;
  state.attachments=[];
  render();
  try{
    const answer=await aiRequest(text,attachments);
    state.chats.push({role:"assistant",content:answer});
    save(STORAGE.chat,state.chats);
  }catch(err){
    state.chats.push({role:"assistant",content:`I couldn't complete that request: ${err.message}`});
    save(STORAGE.chat,state.chats);
  }finally{
    state.busy=false;
    render();
    setTimeout(()=>document.querySelector("#chatInput")?.focus(),0);
  }
}

async function aiRequest(text, attachments){
  if(!state.authenticated){
    throw new Error("Sign in with Google first so the AI can safely read and change your workspace.");
  }
  const form=new FormData();
  form.append("message",text||"Analyze the attached material.");
  form.append("currentView",state.view);
  for(const a of attachments) form.append("files",a.file,a.name);
  try{
    const driveToken=await ensureDriveToken().catch(()=>null);
    if(driveToken) form.append("driveToken",driveToken);
  }catch{}
  const data=await api("/api/ai/chat",{method:"POST",body:form});
  if(data.actions?.length) await applyAiActions(data.actions);
  if(data.document) openDocumentFromServer(data.document);
  return data.reply || "Done.";
}

async function fileToDataUrl(file){return await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(file);});}

async function analyzeCurrentDocument(){
  if(!state.workspace.document)return;
  const d=state.workspace.document;
  state.chats.push({role:"user",content:`Analyze ${d.name} and give me the key study points.`});
  state.busy=true; render();
  try{
    const a=await aiRequest(`Analyze this document named ${d.name}. Give the main points, important definitions/formulas, and 5 things I should remember.`,[d]);
    state.chats.push({role:"assistant",content:a});
  }catch(e){state.chats.push({role:"assistant",content:e.message});}
  state.busy=false; render();
}

function normalizeAiAction(action){
  if(!action||typeof action!=="object")return null;
  const type=String(action.type||action.action||"").trim();
  if(!type)return null;
  if(type==="update_task" && action.patch) return {...action,patch:action.patch};
  return {...action,type};
}

async function applyAiActions(actions){
  for(const raw of actions||[]){
    const action=normalizeAiAction(raw);
    if(!action)continue;

    if(action.type==="create_task"&&action.title){
      const t={id:crypto.randomUUID(),title:String(action.title),due:String(action.due||"No due date"),priority:String(action.priority||"Medium"),done:false,__new:true};
      state.tasks.unshift(t); await persistTask(t);
    }

    if(action.type==="update_task"&&action.id){
      const t=state.tasks.find(x=>x.id===action.id);
      if(t){
        const patch=action.patch||{};
        Object.assign(t,{title:patch.title??t.title,due:patch.due??t.due,priority:patch.priority??t.priority,done:patch.done??t.done});
        save("task-helper.local-tasks",state.tasks);
        if(state.authenticated)await workspaceSave("tasks",{title:t.title,due:t.due,priority:t.priority,done:t.done},t.id);
      }
    }

    if(action.type==="complete_task"&&action.id) await toggleTask(action.id);

    if(action.type==="delete_task"&&action.id){
      await deleteTask(action.id);
    }

    if(action.type==="create_class"&&action.name){
      const item={id:crypto.randomUUID(),name:String(action.name),code:String(action.code||""),schedule:String(action.schedule||""),color:action.color||"#7189ff",tasks:0};
      state.classes.unshift(item);save(STORAGE.classes,state.classes);
      const saved=await workspaceSave("classes",item);if(saved)item.id=saved.id;
    }

    if(action.type==="update_class"&&action.id){
      const item=state.classes.find(x=>x.id===action.id);
      if(item){Object.assign(item,action.patch||{});save(STORAGE.classes,state.classes);await workspaceSave("classes",action.patch||{},action.id);}
    }

    if(action.type==="delete_class"&&action.id){
      state.classes=state.classes.filter(x=>x.id!==action.id);save(STORAGE.classes,state.classes);await workspaceDelete("classes",action.id);
    }

    if((action.type==="create_note"||action.type==="save_note")&&action.title){
      const item={id:crypto.randomUUID(),title:String(action.title),body:String(action.body||""),created:new Date().toLocaleDateString()};
      state.notes.unshift(item);save(STORAGE.notes,state.notes);
      const saved=await workspaceSave("notes",item);if(saved)item.id=saved.id;
    }

    if(action.type==="update_note"&&action.id){
      const item=state.notes.find(x=>x.id===action.id);
      if(item){Object.assign(item,action.patch||{});save(STORAGE.notes,state.notes);await workspaceSave("notes",action.patch||{},action.id);}
    }

    if(action.type==="delete_note"&&action.id){
      state.notes=state.notes.filter(x=>x.id!==action.id);save(STORAGE.notes,state.notes);await workspaceDelete("notes",action.id);
    }

    if(action.type==="create_goal"&&action.title){
      const item={id:crypto.randomUUID(),title:String(action.title),target:String(action.target||""),progress:Number(action.progress)||0};
      state.goals.unshift(item);save(STORAGE.goals,state.goals);
      const saved=await workspaceSave("goals",item);if(saved)item.id=saved.id;
    }

    if(action.type==="update_goal"&&action.id){
      const item=state.goals.find(x=>x.id===action.id);
      if(item){Object.assign(item,action.patch||{});save(STORAGE.goals,state.goals);await workspaceSave("goals",action.patch||{},action.id);}
    }

    if(action.type==="delete_goal"&&action.id){
      state.goals=state.goals.filter(x=>x.id!==action.id);save(STORAGE.goals,state.goals);await workspaceDelete("goals",action.id);
    }

    if((action.type==="create_calendar_event"||action.type==="create_reminder")&&action.title){
      const item={id:crypto.randomUUID(),title:String(action.title),start:action.start||new Date().toISOString(),end:action.end||null,color:action.color||"#7189ff",source:action.type==="create_reminder"?"ai-reminder":"task-helper"};
      state.calendar.push(item);save(STORAGE.calendar,state.calendar);
      const saved=await workspaceSave("calendar",item);if(saved)item.id=saved.id;
      if(action.type==="create_reminder"){state.reminders.push(item);save(STORAGE.reminders,state.reminders);}
      if(action.notify!==false)notifyUser(item.title,`Reminder: ${item.title}`);
    }

    if(action.type==="update_calendar_event"&&action.id){
      const item=state.calendar.find(x=>x.id===action.id);
      if(item){Object.assign(item,action.patch||{});save(STORAGE.calendar,state.calendar);await workspaceSave("calendar",action.patch||{},action.id);}
    }

    if(action.type==="delete_calendar_event"&&action.id){
      state.calendar=state.calendar.filter(x=>x.id!==action.id);save(STORAGE.calendar,state.calendar);await workspaceDelete("calendar",action.id);
    }

    if(action.type==="open_documents")state.view="documents";
    if(action.type==="open_calendar")state.view="calendar";
    if(action.type==="open_tasks")state.view="tasks";
    if(action.type==="open_classes")state.view="classes";
    if(action.type==="open_notes")state.view="notes";
    if(action.type==="open_goals")state.view="goals";
    if(action.type==="open_home")state.view="home";
    if(action.type==="open_view"&&["home","tasks","classes","documents","notes","calendar","goals"].includes(action.view))state.view=action.view;

    if(action.type==="open_document"&&action.id)await openSavedDocument(action.id);

    if(action.type==="focus_mode"){
      state.workspace.focus=action.enabled===false?"chat":"focus";
    }

    if(action.type==="set_timer"){
      const seconds=Math.max(0,Number(action.seconds ?? (Number(action.minutes||0)*60)));
      state.timer={running:false,endsAt:null,remaining:seconds,preset:seconds||25*60};
      if(action.start&&seconds>0){state.timer.endsAt=Date.now()+seconds*1000;state.timer.running=true;}
    }
    if(action.type==="start_timer")startTimer();
    if(action.type==="pause_timer")pauseTimer();
    if(action.type==="reset_timer")resetTimer();
    if(action.type==="start_stopwatch")startStopwatch();
    if(action.type==="pause_stopwatch")pauseStopwatch();
    if(action.type==="reset_stopwatch")resetStopwatch();
  }
  render();
}

function notifyUser(title,body){
  if(!state.settings.notifications)return;
  if("Notification" in window){
    if(Notification.permission==="granted")new Notification(title,{body});
    else if(Notification.permission==="default")Notification.requestPermission().catch(()=>{});
  }
}
async function addUploadedDocument(file){
  if(state.authenticated){
    try{const doc=await uploadToDrive(file);state.workspace.document={...doc,file,preview:file.type.startsWith("image/")?URL.createObjectURL(file):null};state.workspace.center="document";state.view="home";render();return;}catch(error){alert(error.message);}
  }
  const data={id:crypto.randomUUID(),title:file.name,name:file.name,kind:"document",mime:file.type,meta:file.type.startsWith("image/")?"Image material":"PDF material",file,preview:file.type.startsWith("image/")?URL.createObjectURL(file):null};state.notes.unshift(data);save(STORAGE.notes,state.notes);state.workspace.document=data;state.workspace.center="document";state.view="home";render();
}
function openDocumentFromServer(d){state.workspace.document=d;state.workspace.center="document";state.view="home";render();}
async function openSavedDocument(id){const d=(state.documents||[]).find(n=>n.id===id) || state.notes.find(n=>n.id===id);if(!d)return;state.workspace.document={...d,name:d.name||d.title};if(d.drive_file_id && !d.file){try{await refreshDocumentContent(state.workspace.document);}catch(error){state.chats.push({role:"assistant",content:error.message});}}state.workspace.center="document";state.view="home";render();}

function openCommandPalette(){showModal("Quick actions",`<div class="command-list"><button data-command="task">＋ Create a task</button><button data-command="upload">↥ Upload PDF or image</button><button data-command="class">▦ Add a class</button><button data-command="note">✎ New note</button><button data-command="focus">◌ Toggle focus mode</button></div>`);document.querySelectorAll("[data-command]").forEach(b=>b.onclick=()=>{closeModal();({task:openTaskModal,upload:()=>document.querySelector("#filePicker").click(),class:openClassModal,note:openNoteModal,focus:()=>{state.workspace.focus=state.workspace.focus==="focus"?"chat":"focus";render();}}[b.dataset.command])();});}

window.addEventListener("dragover",e=>e.preventDefault());window.addEventListener("drop",e=>{e.preventDefault();const files=[...e.dataTransfer.files].filter(f=>f.type==="application/pdf"||f.type.startsWith("image/"));if(files.length)addAttachments(files);});
if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
setInterval(tickTimeTools, 250);
boot();
