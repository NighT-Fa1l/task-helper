import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { OAuth2Client } from "google-auth-library";
import pg from "pg";
import multer from "multer";
import pdfParse from "pdf-parse";

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 5000);
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
const jwtSecret = process.env.JWT_SECRET;
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const aiApiKey = process.env.AI_API_KEY;
const aiBaseUrl = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const aiModel = process.env.AI_MODEL || "openai/gpt-4o-mini";
const isProduction = process.env.NODE_ENV === "production";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
if (!jwtSecret) throw new Error("JWT_SECRET is required");
if (!googleClientId) throw new Error("GOOGLE_CLIENT_ID is required");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" || isProduction ? { rejectUnauthorized: false } : undefined
});
const googleClient = new OAuth2Client(googleClientId);

app.set("trust proxy", 1);
app.use(cors({ origin: frontendUrl, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 5, fileSize: 12 * 1024 * 1024 } });

const cookieOptions = {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === "true" || isProduction,
  sameSite: isProduction ? "none" : "lax",
  path: "/",
  maxAge: 1000 * 60 * 60 * 24 * 30
};

function signUser(user) { return jwt.sign({ sub: user.id, email: user.email }, jwtSecret, { expiresIn: "30d" }); }

async function auth(req, res, next) {
  try {
    const token = req.cookies.task_helper_session;
    if (!token) return res.status(401).json({ error: "Not authenticated" });
    const payload = jwt.verify(token, jwtSecret);
    const result = await pool.query("SELECT id, email, name, picture FROM users WHERE id = $1", [payload.sub]);
    if (!result.rows[0]) return res.status(401).json({ error: "Session user not found" });
    req.user = result.rows[0];
    next();
  } catch { return res.status(401).json({ error: "Invalid or expired session" }); }
}

function cleanPatch(body, allowed) {
  return Object.fromEntries(Object.entries(body || {}).filter(([key, value]) => allowed.includes(key) && value !== undefined));
}

async function driveRequest(accessToken, url, options = {}) {
  if (!accessToken) throw new Error("Google Drive permission is required for file storage.");
  const response = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` } });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try { message = JSON.parse(text)?.error?.message || message; } catch {}
    throw new Error(`Google Drive: ${message}`);
  }
  return { response, text };
}

async function uploadToGoogleDrive(accessToken, file) {
  const metadata = { name: file.originalname, mimeType: file.mimetype };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", new Blob([file.buffer], { type: file.mimetype }), file.originalname);
  const { text } = await driveRequest(accessToken, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink", { method: "POST", body: form });
  return JSON.parse(text);
}

async function readDriveFile(accessToken, fileId) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error("Could not download the file from Google Drive.");
  return Buffer.from(await response.arrayBuffer());
}

app.get("/api/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true, service: "task-helper-api" }); }
  catch { res.status(503).json({ ok: false, error: "Database unavailable" }); }
});

app.post("/api/auth/google", async (req, res) => {
  try {
    const credential = req.body?.credential;
    if (!credential) return res.status(400).json({ error: "Google credential is required" });
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: googleClientId });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) return res.status(401).json({ error: "Google account could not be verified" });
    if (payload.email_verified === false) return res.status(401).json({ error: "Google email is not verified" });
    const result = await pool.query(
      `INSERT INTO users (id, google_sub, email, name, picture) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (google_sub) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name,picture=EXCLUDED.picture,updated_at=NOW()
       RETURNING id,email,name,picture`,
      [crypto.randomUUID(), payload.sub, payload.email, payload.name || payload.email, payload.picture || ""]
    );
    const user = result.rows[0];
    res.cookie("task_helper_session", signUser(user), cookieOptions);
    res.json({ user });
  } catch (error) { console.error("Google auth failed:", error.message); res.status(401).json({ error: "Google login failed" }); }
});

app.get("/api/auth/me", auth, (req, res) => res.json({ user: req.user }));
app.get("/api/account/settings", auth, async (req,res)=>{
  const r=await pool.query("SELECT personality, memory_summary, ai_model, ai_base_url FROM user_settings WHERE user_id=$1",[req.user.id]);
  const settings=r.rows[0]||{personality:"concise",memory_summary:"",ai_model:aiModel,ai_base_url:aiBaseUrl};
  const chats=await pool.query("SELECT role,content,created_at FROM chat_messages WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30",[req.user.id]);
  res.json({settings,chats:chats.rows.reverse()});
});
app.patch("/api/account/settings", auth, async (req,res)=>{
  const personality=["concise","balanced","detailed"].includes(req.body?.personality)?req.body.personality:"concise";
  const memory=String(req.body?.memory_summary||"").slice(0,12000);
  const model=String(req.body?.ai_model||aiModel).slice(0,160);
  const base=String(req.body?.ai_base_url||aiBaseUrl).replace(/\/$/,"").slice(0,300);
  const r=await pool.query(`INSERT INTO user_settings(user_id,personality,memory_summary,ai_model,ai_base_url) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET personality=EXCLUDED.personality,memory_summary=EXCLUDED.memory_summary,ai_model=EXCLUDED.ai_model,ai_base_url=EXCLUDED.ai_base_url,updated_at=NOW() RETURNING personality,memory_summary,ai_model,ai_base_url`,[req.user.id,personality,memory,model,base]);
  res.json({settings:r.rows[0]});
});
app.delete("/api/chat/history", auth, async (req,res)=>{await pool.query("DELETE FROM chat_messages WHERE user_id=$1",[req.user.id]);res.json({ok:true});});
app.post("/api/auth/logout", (_req, res) => { res.clearCookie("task_helper_session", { ...cookieOptions, maxAge: undefined }); res.json({ ok: true }); });

app.get("/api/workspace", auth, async (req, res) => {
  const uid = req.user.id;
  const [tasks, classes, notes, goals, calendar, documents] = await Promise.all([
    pool.query("SELECT id,title,due,priority,done,created_at,updated_at FROM tasks WHERE user_id=$1 ORDER BY created_at DESC", [uid]),
    pool.query("SELECT id,name,code,schedule,color,tasks FROM classes WHERE user_id=$1 ORDER BY created_at DESC", [uid]),
    pool.query("SELECT id,title,body,created FROM notes WHERE user_id=$1 ORDER BY created_at DESC", [uid]),
    pool.query("SELECT id,title,target,progress FROM goals WHERE user_id=$1 ORDER BY created_at DESC", [uid]),
    pool.query("SELECT id,title,start_at AS start,end_at AS \"end\",color,source FROM calendar_events WHERE user_id=$1 ORDER BY start_at ASC LIMIT 100", [uid]),
    pool.query("SELECT id,name,mime,size,drive_file_id,web_view_link,created_at FROM documents WHERE user_id=$1 ORDER BY created_at DESC", [uid])
  ]);
  res.json({ tasks:tasks.rows, classes:classes.rows, notes:notes.rows, goals:goals.rows, calendar:calendar.rows, documents:documents.rows });
});

app.get("/api/tasks", auth, async (req,res)=>{const r=await pool.query("SELECT id,title,due,priority,done,created_at,updated_at FROM tasks WHERE user_id=$1 ORDER BY created_at DESC",[req.user.id]);res.json({tasks:r.rows});});
app.post("/api/tasks", auth, async (req,res)=>{const {title,due="No due date",priority="Medium",done=false}=req.body||{};if(!title)return res.status(400).json({error:"Task title is required"});const r=await pool.query(`INSERT INTO tasks(id,user_id,title,due,priority,done) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,title,due,priority,done,created_at,updated_at`,[crypto.randomUUID(),req.user.id,title.trim(),String(due),String(priority),Boolean(done)]);res.status(201).json({task:r.rows[0],item:r.rows[0]});});
app.patch("/api/tasks/:id", auth, async (req,res)=>{const patch=cleanPatch(req.body,["title","due","priority","done"]);const entries=Object.entries(patch);if(!entries.length)return res.status(400).json({error:"No task fields supplied"});const sets=entries.map(([k],i)=>`${k}=$${i+1}`);const vals=entries.map(([,v])=>v);vals.push(req.params.id,req.user.id);const r=await pool.query(`UPDATE tasks SET ${sets.join(",")},updated_at=NOW() WHERE id=$${vals.length-1} AND user_id=$${vals.length} RETURNING id,title,due,priority,done,created_at,updated_at`,vals);if(!r.rows[0])return res.status(404).json({error:"Task not found"});res.json({task:r.rows[0],item:r.rows[0]});});
app.delete("/api/tasks/:id", auth, async (req,res)=>{const r=await pool.query("DELETE FROM tasks WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);if(!r.rowCount)return res.status(404).json({error:"Task not found"});res.json({ok:true});});

const resourceDefs = {
  classes: { table:"classes", columns:["name","code","schedule","color","tasks"], select:"id,name,code,schedule,color,tasks" },
  notes: { table:"notes", columns:["title","body","created"], select:"id,title,body,created" },
  goals: { table:"goals", columns:["title","target","progress"], select:"id,title,target,progress" }
};
for (const [resource, def] of Object.entries(resourceDefs)) {
  app.get(`/api/${resource}`, auth, async (req,res)=>{const r=await pool.query(`SELECT ${def.select} FROM ${def.table} WHERE user_id=$1 ORDER BY created_at DESC`,[req.user.id]);res.json({[resource]:r.rows});});
  app.post(`/api/${resource}`, auth, async (req,res)=>{const values=def.columns.map(c=>req.body?.[c] ?? (c==="progress"||c==="tasks"?0:""));const id=crypto.randomUUID();const placeholders=def.columns.map((_,i)=>`$${i+3}`).join(",");const r=await pool.query(`INSERT INTO ${def.table}(id,user_id,${def.columns.join(",")}) VALUES($1,$2,${placeholders}) RETURNING ${def.select}`,[id,req.user.id,...values]);res.status(201).json({item:r.rows[0]});});
  app.patch(`/api/${resource}/:id`, auth, async (req,res)=>{const patch=cleanPatch(req.body,def.columns);const entries=Object.entries(patch);if(!entries.length)return res.status(400).json({error:"No fields supplied"});const sets=entries.map(([k],i)=>`${k}=$${i+1}`);const vals=entries.map(([,v])=>v);vals.push(req.params.id,req.user.id);const r=await pool.query(`UPDATE ${def.table} SET ${sets.join(",")},updated_at=NOW() WHERE id=$${vals.length-1} AND user_id=$${vals.length} RETURNING ${def.select}`,vals);if(!r.rows[0])return res.status(404).json({error:"Item not found"});res.json({item:r.rows[0]});});
  app.delete(`/api/${resource}/:id`, auth, async (req,res)=>{const r=await pool.query(`DELETE FROM ${def.table} WHERE id=$1 AND user_id=$2`,[req.params.id,req.user.id]);if(!r.rowCount)return res.status(404).json({error:"Item not found"});res.json({ok:true});});
}

app.get("/api/calendar", auth, async (req,res)=>{const r=await pool.query("SELECT id,title,start_at AS start,end_at AS \"end\",color,source FROM calendar_events WHERE user_id=$1 ORDER BY start_at ASC",[req.user.id]);res.json({calendar:r.rows});});
app.post("/api/calendar", auth, async (req,res)=>{const {title,start,end=null,color="#7189ff",source="task-helper"}=req.body||{};if(!title||!start)return res.status(400).json({error:"Calendar title and start are required"});const r=await pool.query(`INSERT INTO calendar_events(id,user_id,title,start_at,end_at,color,source) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,title,start_at AS start,end_at AS \"end\",color,source`,[crypto.randomUUID(),req.user.id,title,new Date(start).toISOString(),end?new Date(end).toISOString():null,color,source]);res.status(201).json({item:r.rows[0]});});
app.patch("/api/calendar/:id", auth, async (req,res)=>{const patch=cleanPatch(req.body,["title","start","end","color","source"]);const sets=[];const vals=[];for(const [k,v] of Object.entries(patch)){const db=k==="start"?"start_at":k==="end"?"end_at":k;sets.push(`${db}=$${vals.length+1}`);vals.push((k==="start"||k==="end")&&v?new Date(v).toISOString():v);}if(!sets.length)return res.status(400).json({error:"No fields supplied"});vals.push(req.params.id,req.user.id);const r=await pool.query(`UPDATE calendar_events SET ${sets.join(",")},updated_at=NOW() WHERE id=$${vals.length-1} AND user_id=$${vals.length} RETURNING id,title,start_at AS start,end_at AS \"end\",color,source`,vals);if(!r.rows[0])return res.status(404).json({error:"Event not found"});res.json({item:r.rows[0]});});
app.delete("/api/calendar/:id", auth, async (req,res)=>{const r=await pool.query("DELETE FROM calendar_events WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);if(!r.rowCount)return res.status(404).json({error:"Event not found"});res.json({ok:true});});

app.get("/api/documents", auth, async (req,res)=>{const r=await pool.query("SELECT id,name,mime,size,drive_file_id,web_view_link,created_at FROM documents WHERE user_id=$1 ORDER BY created_at DESC",[req.user.id]);res.json({documents:r.rows});});
app.post("/api/documents", auth, upload.single("file"), async (req,res)=>{
  if(!req.file)return res.status(400).json({error:"File is required"});
  const token=req.get("X-Drive-Access-Token");
  if(!token)return res.status(400).json({error:"Connect Google Drive before uploading files."});
  try{
    const drive=await uploadToGoogleDrive(token,req.file);
    let extracted="";
    if(req.file.mimetype==="application/pdf"){try{const parsed=await pdfParse(req.file.buffer);extracted=String(parsed.text||"").slice(0,180000);}catch{}}
    const r=await pool.query(`INSERT INTO documents(id,user_id,name,mime,size,drive_file_id,web_view_link,extracted_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,mime,size,drive_file_id,web_view_link,created_at`,[crypto.randomUUID(),req.user.id,req.file.originalname,req.file.mimetype,req.file.size,drive.id,drive.webViewLink||`https://drive.google.com/open?id=${drive.id}`,extracted]);
    res.status(201).json({document:r.rows[0]});
  }catch(error){console.error("Drive upload failed:",error);res.status(502).json({error:error.message});}
});
app.get("/api/documents/:id/content", auth, async (req,res)=>{const r=await pool.query("SELECT id,name,mime,drive_file_id FROM documents WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);if(!r.rows[0])return res.status(404).json({error:"Document not found"});try{const buffer=await readDriveFile(req.get("X-Drive-Access-Token"),r.rows[0].drive_file_id);res.setHeader("Content-Type",r.rows[0].mime);res.setHeader("Content-Disposition",`inline; filename*=UTF-8''${encodeURIComponent(r.rows[0].name)}`);res.send(buffer);}catch(error){res.status(502).json({error:error.message});}});
app.delete("/api/documents/:id", auth, async (req,res)=>{const r=await pool.query("DELETE FROM documents WHERE id=$1 AND user_id=$2",[req.params.id,req.user.id]);if(!r.rowCount)return res.status(404).json({error:"Document not found"});res.json({ok:true});});

app.post("/api/ai/chat", auth, upload.array("files",5), async (req,res)=>{
  if(!aiApiKey)return res.status(503).json({error:"AI is not configured. Set the server AI_API_KEY once; users do not need to enter API keys in the browser."});
  try{
    const uid=req.user.id;
    const settingsResult=await pool.query("SELECT personality,memory_summary,ai_model,ai_base_url FROM user_settings WHERE user_id=$1",[uid]);
    const userSettings=settingsResult.rows[0]||{personality:"concise",memory_summary:"",ai_model:aiModel,ai_base_url:aiBaseUrl};
    const historyResult=await pool.query("SELECT role,content FROM chat_messages WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20",[uid]);
    const history=historyResult.rows.reverse();
    const [tasks,classes,notes,goals,calendar,documents]=await Promise.all([
      pool.query("SELECT id,title,due,priority,done FROM tasks WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100",[uid]),
      pool.query("SELECT id,name,code,schedule,color,tasks FROM classes WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",[uid]),
      pool.query("SELECT id,title,body,created FROM notes WHERE user_id=$1 ORDER BY created_at DESC LIMIT 80",[uid]),
      pool.query("SELECT id,title,target,progress FROM goals WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50",[uid]),
      pool.query("SELECT id,title,start_at AS start,end_at AS \"end\",color FROM calendar_events WHERE user_id=$1 ORDER BY start_at ASC LIMIT 100",[uid]),
      pool.query("SELECT id,name,mime,drive_file_id,extracted_text FROM documents WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30",[uid])
    ]);
    const userMessage=String(req.body?.message||"Analyze the supplied material.").slice(0,16000); const currentView=String(req.body?.currentView||"home");
    const context={user:{name:req.user.name,email:req.user.email},tasks:tasks.rows,classes:classes.rows,notes:notes.rows,goals:goals.rows,calendar:calendar.rows,documents:documents.rows.map(d=>({id:d.id,name:d.name,mime:d.mime,drive_file_id:d.drive_file_id,extracted_text:d.extracted_text.slice(0,12000)}))};
    const content=[{type:"text",text:`User request:\n${userMessage}\n\nCurrent Task Helper data (this is the user's actual workspace; use IDs exactly):\n${JSON.stringify(context)}`}];
    const uploaded=[];
    const driveToken=req.body?.driveToken || req.get("X-Drive-Access-Token");
    for(const file of req.files||[]){
      if(file.mimetype==="application/pdf"){const parsed=await pdfParse(file.buffer);const text=String(parsed.text||"").slice(0,100000);uploaded.push({name:file.originalname,type:"pdf",pages:parsed.numpages||null,text});content.push({type:"text",text:`PDF: ${file.originalname}\n${text}`});}
      else if(file.mimetype.startsWith("image/")){const dataUrl=`data:${file.mimetype};base64,${file.buffer.toString("base64")}`;uploaded.push({name:file.originalname,type:"image"});content.push({type:"text",text:`Image attached: ${file.originalname}`},{type:"image_url",image_url:{url:dataUrl,detail:"auto"}});}
      if(driveToken){try{const drive=await uploadToGoogleDrive(driveToken,file);let extracted="";if(file.mimetype==="application/pdf"){try{const parsed=await pdfParse(file.buffer);extracted=String(parsed.text||"").slice(0,180000);}catch{}}await pool.query(`INSERT INTO documents(id,user_id,name,mime,size,drive_file_id,web_view_link,extracted_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[crypto.randomUUID(),uid,file.originalname,file.mimetype,file.size,drive.id,drive.webViewLink||`https://drive.google.com/open?id=${drive.id}`,extracted]);}catch(error){console.warn("AI attachment Drive save skipped:",error.message);}}
    }
    const personalityInstruction={concise:"Be very concise. Give the result first. Usually 1-3 short sentences. Do not add explanations unless needed.",balanced:"Be concise but include the key reason or next step when useful.",detailed:"Give useful detail when it materially helps, but avoid repetition and filler."}[userSettings.personality]||"Be very concise.";
const system=`You are Task Helper, the user's workspace agent. You do not merely give instructions: when the user asks you to change, save, open, organize, schedule, remind, or manage something, return the actions needed so the web app performs it immediately.

Return ONLY valid JSON in this exact shape: {"reply":"string","actions":[...],"memory":"string"}. The memory field is a short durable summary for future chats; keep it under 2000 characters and update it only with useful non-sensitive preferences, ongoing workspace facts, or explicit things the user asks you to remember. Preserve useful existing memory.

You have the user's current workspace and may act on it. Never invent IDs. For updates/deletes/opening a specific existing item, use an ID from the supplied workspace data. For new items, do not provide an ID.

Supported actions:
- create_task {title,due,priority}
- update_task {id,patch:{title,due,priority,done}}
- complete_task {id}
- delete_task {id}
- create_class {name,code,schedule,color}
- update_class {id,patch}
- delete_class {id}
- create_note {title,body} or save_note {title,body}
- update_note {id,patch}
- delete_note {id}
- create_goal {title,target,progress}
- update_goal {id,patch}
- delete_goal {id}
- create_calendar_event {title,start,end,color}
- update_calendar_event {id,patch}
- delete_calendar_event {id}
- create_reminder {title,start,end,color,notify}
- open_home
- open_tasks
- open_classes
- open_documents
- open_notes
- open_calendar
- open_goals
- open_view {view}
- open_document {id}
- focus_mode {enabled}
- set_timer {seconds OR minutes,start}
- start_timer, pause_timer, reset_timer
- start_stopwatch, pause_stopwatch, reset_stopwatch

Interpret natural language dates/times. Use ISO timestamps when creating calendar events or reminders. If the user says "remind me", create_reminder. If they say "save this", save_note unless they clearly mean another workspace object. If they say "open/show/go to", use an open action. If they ask what is in a document, use its extracted text/context and answer it; opening it is optional unless requested. If they ask to organize or change workspace data, perform the changes instead of only describing them. Multiple actions are allowed and should be ordered logically.

The current UI view is "${currentView}". The workspace JSON below is authoritative for this user.
Keep replies concise, natural, and confirm completed actions. ${personalityInstruction}
The user's saved memory summary is below. Use it only when relevant; do not repeat it back unless asked.
${userSettings.memory_summary||"(none)"}
If no workspace action is needed, actions must be [].
`
    const messages=[{role:"system",content:system},...history,{role:"user",content}];
    const response=await fetch(`${userSettings.ai_base_url||aiBaseUrl}/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${aiApiKey}`},body:JSON.stringify({model:userSettings.ai_model||aiModel,messages,temperature:.15})});
    const raw=await response.json();if(!response.ok)throw new Error(raw?.error?.message||"AI provider request failed");const text=raw?.choices?.[0]?.message?.content||"No response.";let parsed;try{parsed=JSON.parse(text)}catch{const cleaned=text.replace(/^```(?:json)?\\s*/i,"").replace(/\\s*```$/,"").trim();try{parsed=JSON.parse(cleaned)}catch{parsed={reply:text,actions:[]}}}const reply=parsed.reply||text;
    await pool.query("INSERT INTO chat_messages(user_id,role,content) VALUES($1,$2,$3),($1,$4,$5)",[uid,"user",userMessage,"assistant",String(reply).slice(0,20000)]);
    if(typeof parsed.memory === "string" && parsed.memory.trim() && parsed.memory.trim() !== userSettings.memory_summary.trim()){
      await pool.query("INSERT INTO user_settings(user_id,personality,memory_summary,ai_model,ai_base_url) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO UPDATE SET memory_summary=EXCLUDED.memory_summary,updated_at=NOW()",[uid,userSettings.personality,parsed.memory.trim().slice(0,12000),userSettings.ai_model||aiModel,userSettings.ai_base_url||aiBaseUrl]);
    }
    await pool.query("DELETE FROM chat_messages WHERE user_id=$1 AND id NOT IN (SELECT id FROM chat_messages WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100)",[uid]);
    res.json({reply,actions:Array.isArray(parsed.actions)?parsed.actions:[],uploaded,memory:typeof parsed.memory === "string" ? parsed.memory.trim() : userSettings.memory_summary});
  }catch(error){console.error("AI request failed:",error);res.status(500).json({error:error.message||"AI request failed"});}
});

app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:"Internal server error"});});

async function initDatabase(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(id UUID PRIMARY KEY,google_sub TEXT UNIQUE NOT NULL,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL DEFAULT '',picture TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS tasks(id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,due TEXT NOT NULL DEFAULT 'No due date',priority TEXT NOT NULL DEFAULT 'Medium',done BOOLEAN NOT NULL DEFAULT FALSE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS classes(id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,code TEXT NOT NULL DEFAULT '',schedule TEXT NOT NULL DEFAULT '',color TEXT NOT NULL DEFAULT '#7189ff',tasks INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS notes(id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',created TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS goals(id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,target TEXT NOT NULL DEFAULT '',progress INTEGER NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS calendar_events(id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,start_at TIMESTAMPTZ NOT NULL,end_at TIMESTAMPTZ,color TEXT NOT NULL DEFAULT '#7189ff',source TEXT NOT NULL DEFAULT 'task-helper',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS documents(id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,name TEXT NOT NULL,mime TEXT NOT NULL,size BIGINT NOT NULL DEFAULT 0,drive_file_id TEXT NOT NULL,web_view_link TEXT NOT NULL DEFAULT '',extracted_text TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS user_settings(user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,personality TEXT NOT NULL DEFAULT 'concise',memory_summary TEXT NOT NULL DEFAULT '',ai_model TEXT NOT NULL DEFAULT '',ai_base_url TEXT NOT NULL DEFAULT '',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS chat_messages(id BIGSERIAL PRIMARY KEY,user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),content TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE INDEX IF NOT EXISTS chat_messages_user_created_idx ON chat_messages(user_id,created_at DESC);
  `);
}

initDatabase().then(()=>app.listen(port,()=>console.log(`Task Helper API listening on port ${port}`))).catch(error=>{console.error("Database initialization failed:",error);process.exit(1);});
