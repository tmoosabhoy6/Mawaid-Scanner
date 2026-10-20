'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, x => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[x]));
const e = escapeHtml;
let role, currentView = '', camera = null, service = null, scannerTimer = null, scannerBusy = false, printSettings = null;
const dates = v => v ? new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Baghdad'}).format(new Date(v)) : '—';
const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Baghdad'}).format(new Date());
async function apiResponse(path, body) {
  const response = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type':'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== '/login') login(); throw new Error(result.error || 'Request failed.'); }
  return { result, response };
}
async function api(path, body) { return (await apiResponse(path, body)).result; }
function notify(message) { $('#notice').textContent = message; $('#notice').classList.add('visible'); clearTimeout(notify.timer); notify.timer = setTimeout(()=>$('#notice').classList.remove('visible'),7000); }
async function guard(fn) { try { await fn(); } catch (err) { notify(err.message); } }
async function busy(button, fn) { if (button.disabled) return; button.disabled = true; try { await fn(); } finally { button.disabled = false; } }
const brand = `<div class="brand"><strong><span class="brand-mark">م</span>Mawayid</strong><small>Faize Husseini · Karbala</small></div>`;
async function stopScanner() { clearInterval(scannerTimer); scannerTimer = null; if (camera) { try { await camera.stop(); } catch {} camera = null; } }
function login() {
  stopScanner(); role = null;
  const scanner = location.pathname === '/scanner';
  $('#app').innerHTML = `<div class="login">${brand}<section class="panel"><div class="eyebrow">Welcome</div><h1>${scanner ? 'Meal scanner' : 'Mawayid printing system'}</h1><p>Sign in to ${scanner ? 'scan meal cards' : 'manage tours and print cards'}.</p><form id="loginForm"><label>Access<select name="role"><option value="${scanner?'scanner':'admin'}">${scanner?'Scanner':'Administrator'}</option><option value="${scanner?'admin':'scanner'}">${scanner?'Administrator':'Scanner'}</option></select></label><label>Password<input name="password" type="password" autocomplete="current-password" required autofocus></label><div class="error" id="loginError" role="alert"></div><button class="primary">Sign in</button></form><small>Meal access follows Karbala time (Asia/Baghdad).<br>Breakfast 6:30–9 am · Lunch 12:30–3 pm · Dinner 7–9:30 pm</small></section></div>`;
  $('#loginForm').onsubmit = async event => { event.preventDefault(); const f = new FormData(event.target); await busy($('button',event.target),async()=>{try { const data = await api('/login',Object.fromEntries(f)); role=data.role; await route(); } catch(err) { $('#loginError').textContent=err.message; } }); };
}
const navs = [['tours','▦','Tours'],['generate','＋','Add tour'],['prints','▤','Print log'],['logs','⌁','Scan log'],['summary','◫','Daily summary'],['settings','⚙','Settings']];
async function shell(view) {
  await stopScanner(); currentView=view;
  $('#app').innerHTML=`<div class="shell"><aside class="sidebar">${brand}<nav class="nav">${navs.map(([key,icon,label])=>`<a href="#${key}" class="${key===view?'active':''}"><span aria-hidden="true">${icon}</span>${label}</a>`).join('')}</nav><div class="foot"><a href="/scanner" target="_blank" rel="noopener">Open meal scanner ↗</a><small>Asia/Baghdad<br>Three meals. One card.</small><button id="logout">Sign out</button></div></aside><div><header class="topbar"><span>MAWAYID PRINTING SYSTEM</span><span>${e(today())} · Karbala <button id="topLogout">Sign out</button></span></header><main id="main"></main></div></div>`;
  $('#logout').onclick=logout; $('#topLogout').onclick=logout;
}
async function logout(){ await guard(async()=>{await api('/logout',{});login();}); }
const heading=(title,desc,action='')=>`<div class="heading"><div><div class="eyebrow">Faize Husseini Karbala</div><h1>${title}</h1><p>${desc}</p></div>${action}</div>`;
async function route(){
  if(!role)return;
  if(location.pathname==='/scanner'||role==='scanner')return scannerView();
  const view=location.hash.slice(1)||'tours'; await shell(view);
  await guard(async()=>{await ({tours:toursView,generate:generateView,prints:printsView,logs:logsView,summary:summaryView,settings:settingsView}[view]||toursView)();});
}
window.addEventListener('hashchange',route);
async function toursView(){
  $('#main').innerHTML=heading('Tours','Find an arrival date, select your tours, and print their meal cards.',`<button class="primary" id="newTour">＋ Add tour</button>`)+`<section class="panel"><form class="filters" id="tourFilters"><label>Arrival date<input type="date" name="arrival"></label><label>Tour ID or office<input name="q" placeholder="Search tours…"></label><button>Apply</button><button type="reset">Reset</button></form></section><section class="panel"><div class="tablebar"><span id="tourCount" class="muted">Loading…</span><button class="primary" id="printSelected" disabled>Print selected</button></div><div class="tablewrap" id="tourTable"></div></section>`;
  $('#newTour').onclick=()=>location.hash='generate';
  const load=async()=>{const params=new URLSearchParams(new FormData($('#tourFilters')));const {result:rows,response}=await apiResponse(`/tours?${params}`);
    const total=Number(response.headers?.get('X-Total-Count'))||rows.length,filtered=params.get('arrival')||params.get('q');
    const count=n=>`${n.toLocaleString('en-GB')} ${filtered?'':'current and upcoming '}tour${n===1?'':'s'}`;
    $('#tourCount').textContent=total>rows.length?`Showing ${rows.length.toLocaleString('en-GB')} of ${count(total)} — filter by arrival date or search to narrow the list`:count(rows.length);
    $('#tourTable').innerHTML=rows.length?`<table><thead><tr><th><input type="checkbox" id="allTours" aria-label="Select all unprinted tours"></th><th>Tour ID</th><th>Office</th><th>Arrival</th><th>Departure</th><th>PAX</th><th>Print log</th><th>Lost cards</th></tr></thead><tbody>${rows.map(t=>`<tr><td><input class="tour-check" type="checkbox" value="${e(t.id)}" aria-label="Select tour ${e(t.tour_id)}" ${t.issued>=t.pax?'disabled':''}></td><td><strong>${e(t.tour_id)}</strong></td><td>${e(t.office)}</td><td>${e(t.arrival)}</td><td>${e(t.departure)}</td><td>${e(t.pax)} <small>· ${e(t.issued)} issued</small></td><td>${t.batch_id?`<a href="/api/batches/${e(t.batch_id)}/pdf" target="_blank" rel="noopener">View PDF ↗</a>`:'<span class="chip">Not printed</span>'}</td><td><button class="replace" data-tour="${e(t.id)}" ${!t.issued?'disabled':''}>Replace cards</button></td></tr>`).join('')}</tbody></table>`:`<div class="empty"><h2>No tours to show</h2><p>Add a tour, or connect your Google Sheet in Settings.</p></div>`;
    const update=()=>{$('#printSelected').disabled=!$$('.tour-check:checked').length;};
    if($('#allTours'))$('#allTours').onchange=event=>{$$('.tour-check:not(:disabled)').forEach(c=>c.checked=event.target.checked);update();};
    $$('.tour-check').forEach(c=>c.onchange=update);$$('.replace').forEach(b=>b.onclick=()=>guard(()=>replaceCards(b.dataset.tour)));update();
  };
  $('#tourFilters').onsubmit=ev=>{ev.preventDefault();guard(load);};$('#tourFilters').onreset=()=>setTimeout(()=>guard(load),0);
  $('#printSelected').onclick=()=>guard(async()=>{await busy($('#printSelected'),()=>createLabels({tourIds:$$('.tour-check:checked').map(c=>c.value)}));await load();});
  await load();
}
async function generateView(){
  $('#main').innerHTML=heading('Add tour','Create meal entitlements for people who are not in the sheet.')+`<section class="panel"><form class="form" id="addTour"><div class="grid"><label>Tour ID<input name="tour_id" maxlength="80" required placeholder="e.g. 26/3205"></label><label>Office name<input name="office" maxlength="160" required placeholder="Tour office"></label><label>Arrival date<input name="arrival" type="date" required></label><label>Departure date<input name="departure" type="date" required></label><label>Number of people (PAX)<input name="pax" type="number" min="1" max="10000" step="1" required></label></div><div class="helper">Each person gets one unique QR card for breakfast, lunch, and dinner throughout their stay. If this tour already exists for the same arrival date, use <strong>Replace cards</strong> to replace lost cards while keeping the original meal limits.</div><div class="actions"><button type="submit" name="action" value="save">Submit</button><button type="submit" class="primary" name="action" value="print">Submit &amp; print</button></div></form></section>`;
  $('#addTour').onsubmit=ev=>{ev.preventDefault();const action=ev.submitter.value;const button=ev.submitter;guard(()=>busy(button,async()=>{const result=await api('/tours',Object.fromEntries(new FormData(ev.target)));if(result.existing){notify('This stay already exists. Choose the people whose cards were lost.');await replaceCards(result.id);return;}notify('Tour added.');if(action==='print')await createLabels({tourIds:[result.id]});location.hash='tours';}));};
}
async function replaceCards(tourId){
  window.mawayidBatchLimit=(await api('/settings')).maxLabels||500;
  const people=await api(`/tours/${tourId}/people`);
  $('#peopleContent').innerHTML=`<h2>Replace lost cards</h2><p>Choose each person whose card was lost. Their old QR stops working; meals they already used stay used. There is no total replacement limit.</p><div class="person-list">${people.map(p=>`<label><input type="checkbox" value="${e(p.id)}"> Person ${e(p.person_no)}</label>`).join('')}</div><button class="primary" id="replaceSelected">Replace &amp; print selected</button><p class="status-note">Maximum ${window.mawayidBatchLimit||500} labels in one print job.</p>`;
  $('#peopleDialog').showModal();
  $('#replaceSelected').onclick=()=>guard(()=>busy($('#replaceSelected'),async()=>{const ids=$$('#peopleContent input:checked').map(c=>c.value);if(!ids.length)throw new Error('Choose at least one person.');await createLabels({personIds:ids,expectedCardIds:Object.fromEntries(people.filter(p=>ids.includes(p.id)).map(p=>[p.id,p.card_id]))});$('#peopleDialog').close();}));
}
let pendingLabelJob=null;
async function createLabels(selection){
  const fingerprint=JSON.stringify(selection);
  if(!pendingLabelJob||pendingLabelJob.fingerprint!==fingerprint)pendingLabelJob={fingerprint,key:crypto.randomUUID()};
  notify('Preparing unique QR labels…');
  const batch=await api('/labels',{...selection,requestKey:pendingLabelJob.key});
  if(batch.requiresPdfUpload)await finishPdf(batch);
  pendingLabelJob=null;
  notify('PDF saved in the print log. Sending to the printer…');
  const sent = await printBatch(batch.id);
  if(batch.remaining && sent)await createLabels(selection);
  else if(batch.remaining)notify(`PDF saved. ${batch.remaining} more people still need labels. Retry this job from Print log, then select the tour again.`);
}
let pdfLibraryPromise;
async function finishPdf(batch){
  if(!batch.requiresPdfUpload)return;
  if(!batch.cards)batch=await api(`/batches/${batch.id}/manifest`);
  if(!pdfLibraryPromise)pdfLibraryPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/vendor/pdf.js';script.onload=resolve;script.onerror=()=>{pdfLibraryPromise=null;script.remove();reject(new Error('The PDF library could not load. Retry from Print log.'));};document.head.appendChild(script);});
  await pdfLibraryPromise;
  notify('Generating labels on this computer…');
  const pdf=await window.generateMawayidPdf(batch.cards,batch.printer);
  const response=await fetch(`/api/batches/${batch.id}/pdf`,{method:'POST',headers:{'Content-Type':'application/pdf'},body:pdf});
  if(!response.ok){const result=await response.json();throw new Error(result.error||'The PDF could not be saved. Use Finish PDF in Print log.');}
}
async function printBatch(id){
  try {
    printSettings=(await api('/settings')).printer;
    if(!window.qz)throw new Error('Printer library did not load. Reload the page.');
    if(!qz.websocket.isActive())await qz.websocket.connect();
    const printerName=await qz.printers.find(printSettings.name);
    const response=await fetch(`/api/batches/${id}/pdf`);if(!response.ok)throw new Error('Could not fetch the saved label PDF.');
    const bytes=new Uint8Array(await response.arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
    const config=qz.configs.create(printerName,{size:{width:printSettings.widthMm,height:printSettings.heightMm},units:'mm',colorType:'blackwhite',scaleContent:false,margins:0,jobName:'Mawayid meal cards'});
    await qz.print(config,[{type:'pixel',format:'pdf',flavor:'base64',data:btoa(binary)}]);
    await api(`/batches/${id}/status`,{status:'sent_to_printer'});notify('Job sent to the Zebra printer. Check the physical labels.');return true;
  } catch(err) {
    await api(`/batches/${id}/status`,{status:'printer_error'}).catch(()=>{});
    notify(`PDF saved. Printer connection needs attention: ${err.message}. Open Print log to retry.`);return false;
  }
}
async function printsView(){
  const batches=await api('/batches');
  $('#main').innerHTML=heading('Print log','Every generated label PDF is saved here. Reprinting the PDF uses the same QR codes.')+`<section class="panel tablewrap">${batches.length?`<table><thead><tr><th>Created · Karbala</th><th>Type</th><th>Labels</th><th>Printer</th><th>Saved PDF</th><th>Action</th></tr></thead><tbody>${batches.map(b=>`<tr><td>${e(dates(b.created_at))}</td><td>${e(b.kind)}</td><td>${e(b.count)} <small>· ${e(b.active_count)} active</small></td><td><span class="chip">${e(b.printer_status.replaceAll('_',' '))}</span></td><td>${b.pdf_ready===0?'<span class="chip">PDF pending</span>':`<a href="/api/batches/${e(b.id)}/pdf" target="_blank" rel="noopener">View PDF ↗</a>`}</td><td><button class="retry-print" data-pending="${b.pdf_ready===0}" data-id="${e(b.id)}" ${!b.active_count?'disabled':''}>${b.pdf_ready===0?'Finish PDF':'Print PDF'}</button></td></tr>`).join('')}</tbody></table>`:'<div class="empty">No label PDFs yet.</div>'}</section><p>Older PDFs can include replaced QR codes; reprinting does not reactivate them. “Sent to printer” confirms that QZ Tray accepted the job, not that a physical label printed.</p>`;
  $$('.retry-print').forEach(b=>b.onclick=()=>guard(()=>busy(b,async()=>{if(b.dataset.pending==='true'){await finishPdf(await api(`/batches/${b.dataset.id}/manifest`));await printsView();}else await printBatch(b.dataset.id);})));
}
async function logsView(){
  $('#main').innerHTML=heading('Scan log','Review meal admissions and declined scans across every scanner.')+`<section class="panel"><form class="filters" id="logFilters"><label>Date<input type="date" name="date" value="${today()}"></label><label>Tour ID<input name="tour"></label><label>Office<input name="office"></label><label>Status<select name="status"><option value="">All</option><option value="green">Green · admitted</option><option value="red">Red · declined</option></select></label><button>Apply</button><button type="reset">Reset</button></form></section><section class="panel tablewrap" id="logTable"></section>`;
  const load=async()=>{const rows=await api(`/logs?${new URLSearchParams(new FormData($('#logFilters')))}`);$('#logTable').innerHTML=rows.length?`<table><thead><tr><th>Time · Karbala</th><th>Tour ID</th><th>Office</th><th>Person</th><th>Meal</th><th>Status</th><th>Reason</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${e(dates(r.scanned_at))}</td><td>${e(r.display_tour||'—')}</td><td>${e(r.office||'—')}</td><td>${e(r.person_no||'—')}</td><td>${e(r.meal||'Closed')}</td><td><span class="chip ${r.reason==='admitted'?'green-chip':'red-chip'}">${r.reason==='admitted'?'Green':'Red'}</span></td><td>${e(r.reason.replaceAll('_',' '))}</td></tr>`).join('')}</tbody></table><p class="status-note">Latest 1,000 matching attempts.</p>`:'<div class="empty">No scans match these filters.</div>';};
  $('#logFilters').onsubmit=ev=>{ev.preventDefault();guard(load);};$('#logFilters').onreset=()=>setTimeout(()=>guard(load),0);await load();
}
async function summaryView(){
  $('#main').innerHTML=heading('Daily meal summary','Accepted meals only. Replaced cards and duplicate scans never add to these counts.')+`<section class="panel"><form class="filters" id="summaryFilters"><label>Service date<input type="date" name="date" value="${today()}"></label><button>Apply</button></form></section><div id="summaryContent"></div>`;
  const load=async()=>{const rows=await api(`/summary?${new URLSearchParams(new FormData($('#summaryFilters')))}`);const total=key=>rows.reduce((sum,r)=>sum+Number(r[key]),0);$('#summaryContent').innerHTML=`<div class="metric-row">${['breakfast','lunch','dinner'].map(m=>`<div class="metric"><small>${m[0].toUpperCase()+m.slice(1)}</small><strong>${total(m)}</strong><small>of ${total('pax')} eligible people</small></div>`).join('')}</div><section class="panel tablewrap">${rows.length?`<table><thead><tr><th>Tour</th><th>Office</th><th>PAX</th><th>Breakfast</th><th>Lunch</th><th>Dinner</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${e(r.tour_id)}</td><td>${e(r.office)}</td><td>${r.pax}</td><td>${r.breakfast}</td><td>${r.lunch}</td><td>${r.dinner}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">No eligible tours for this date.</div>'}</section>`;};
  $('#summaryFilters').onsubmit=ev=>{ev.preventDefault();guard(load);};await load();
}
async function settingsView(){
  const settings=await api('/settings'),p=settings.printer,s=settings.source;window.mawayidBatchLimit=settings.maxLabels||500;
  $('#main').innerHTML=heading('Settings','Connect your tours and prepare the Zebra ZD220D.')+`${settings.hosting==='cloudflare-free'?`<section class="panel"><h2>Free hosting storage</h2><p>${(settings.databaseBytes/1000000).toFixed(1)} MB used of the 500 MB database limit. Saved PDFs and scan history count toward this limit. Export and archive records before storage fills; data is never automatically deleted.</p></section>`:''}<section class="panel"><h2>Google Sheet</h2><p>Pehli Ziyarat is the arrival date. Departure is the day after Wada Ziyarat.</p><p>The separate ToursSync Apps Script sends updates to this app. The existing flatten function and trigger stay in place.</p><form class="form" id="sourceSettings"><label>Google Sheet URL<input name="url" value="https://docs.google.com/spreadsheets/d/${e(s.spreadsheetId)}/edit" required></label><div class="grid"><label>Source tab<input name="tab" list="sourceTabs" value="${e(s.tab)}" required><datalist id="sourceTabs">${(settings.sync?.tabs||[]).map(t=>`<option value="${e(t)}">`).join('')}</datalist></label><div><small>Sheet tabs become available after the first successful sync.</small></div></div><label>Daily sync times in Karbala (optional)<input name="dailyTimes" value="${e((s.dailyTimes||[]).join(', '))}" placeholder="Leave blank for every 5 minutes, or 06:00, 12:00, 18:00"></label><button>Save sheet connection</button><button type="button" id="requestSync">Request sync</button></form><p class="status-note">${settings.sync?`Last successful sync: ${e(dates(settings.sync.lastSuccess))} · ${settings.sync.imported} stays`:'No sync received yet. Install apps-script/ToursSync.js and run its setup function.'}</p>${(settings.sync?.warnings||[]).map(w=>`<p class="warning-note">${e(w)}</p>`).join('')}</section><section class="panel"><h2>Zebra ZD220D</h2><p>Install QZ Tray and the Zebra driver on the USB-connected printing computer. Open this app on that computer. Your stickers are 3 inches wide × 2 inches high (76.2 × 50.8 mm).</p><form class="form" id="printerSettings"><label>Printer name (as shown by the computer)<input name="name" value="${e(p.name)}" required></label><div class="grid"><label>Label width (mm)<input type="number" name="widthMm" min="40" max="104" step="0.1" value="${p.widthMm}" required></label><label>Label height (mm)<input type="number" name="heightMm" min="50.8" max="200" step="0.1" value="${p.heightMm}" required></label></div><small>${p.confirmed?'Label dimensions confirmed.':'Save the printer settings to confirm these dimensions.'} For labels below 80 mm high, width must be at least 70 mm.</small><button>Confirm &amp; save printer settings</button></form><p class="status-note">Saved PDFs have a maroon border. The ZD220D prints black only. QZ Tray may ask you to approve the site; fully silent printing requires a trusted QZ certificate.</p></section><section class="panel"><h2>Meal rules · Karbala time</h2><div class="meal-strip">${settings.meals.map(m=>`<div>${e(m.name)}<span>${e(m.hours)}</span></div>`).join('')}</div><p>Arrival and departure dates are included. A meal opens at its start time and closes exactly at its end time. Outside these periods, the scanner is closed.</p><a href="/scanner" target="_blank" rel="noopener">Open scanner link ↗</a></section>`;
  $('#sourceSettings').onsubmit=ev=>{ev.preventDefault();guard(async()=>{const f=new FormData(ev.target),id=String(f.get('url')).match(/\/spreadsheets\/d\/([\w-]+)/)?.[1];if(!id)throw new Error('Enter a Google Sheets URL.');await api('/settings',{source:{spreadsheetId:id,tab:f.get('tab'),dailyTimes:String(f.get('dailyTimes')||'').split(',').map(t=>t.trim()).filter(Boolean)}});notify('Sheet connection saved. Use the same tab in the separate Apps Script.');});};
  $('#requestSync').onclick=()=>guard(async()=>{await api('/sync/request',{});notify('Sync requested. The separate Apps Script will send it on its next five-minute run.');});
  $('#printerSettings').onsubmit=ev=>{ev.preventDefault();guard(async()=>{const f=new FormData(ev.target);await api('/settings',{printer:{name:f.get('name'),widthMm:Number(f.get('widthMm')),heightMm:Number(f.get('heightMm'))}});notify('Printer settings confirmed.');});};
}
async function scannerView(){
  await stopScanner();currentView='scanner';
  $('#app').innerHTML=`<div class="scanner-shell"><header class="scanner-head"><h1><span class="brand-mark">م</span>Mawayid scanner</h1><button id="scannerLogout">Sign out</button></header><small>FAIZE HUSSEINI KARBALA · ASIA/BAGHDAD</small><div id="serviceMeals" class="meal-strip"></div><div class="scan-result" id="scanResult" role="status" aria-live="assertive"><strong>Checking meal service…</strong></div><div class="camera-box" id="reader"></div><button class="primary" id="startCamera" disabled>Start camera</button><p class="scan-tip">Hold one QR inside the frame. Wait for the result before admitting anyone.</p><details class="manual"><summary>Use a USB scanner or enter a QR value</summary><form id="manualScan"><input id="manualCode" aria-label="QR code value" placeholder="MW1:…" autocomplete="off" required><button disabled id="manualSubmit">Scan</button></form></details><p class="status-note" id="scannerStatus"></p>${role==='admin'?'<a href="/">Back to printing system</a>':''}</div>`;
  $('#scannerLogout').onclick=logout;
  let lastCode='',lastAt=0,serviceOffset=0,closed=true;
  const update=async()=>{
    try{service=await api('/service');serviceOffset=new Date(service.serverTime).getTime()-Date.now();closed=!service.meal;
      $('#serviceMeals').innerHTML=service.meals.map(m=>`<div class="${service.meal?.id===m.id?'current':''}">${e(m.name)}<span>${e(m.hours)}</span></div>`).join('');
      $('#startCamera').disabled=closed||Boolean(camera);$('#manualSubmit').disabled=closed;
      $('#scannerStatus').textContent=`${service.meal?service.meal.name+' service open':'Meal service closed'} · Device connected`;
      if(closed){await stopScannerCamera();showResult('','Meal service closed','Scanning is available only during the meal times above.');}
      else if(!scannerBusy&&!lastAt)showResult('','Ready to scan',`${service.meal.name} · ${service.date}`);
    }catch(err){closed=true;$('#startCamera').disabled=true;$('#manualSubmit').disabled=true;await stopScannerCamera();showResult('red','Connection unavailable','Admission is blocked until the server is reachable.');}
  };
  async function stopScannerCamera(){if(camera){try{await camera.stop();}catch{}camera=null;}}
  async function submit(code){
    if(scannerBusy||closed)return; if(code===lastCode&&Date.now()-lastAt<3000)return;
    scannerBusy=true;lastCode=code;lastAt=Date.now();
    showResult('','Checking card…','Please wait for the result.');
    try{const result=await api('/scan',{code,requestKey:crypto.randomUUID()});showResult(result.status,result.status==='green'?'ALLOW':'DO NOT ADMIT',result.message+(result.person_no?` · Person ${result.person_no}`:''));beep(result.status==='green');}
    catch(err){showResult('red','DO NOT ADMIT','No confirmed admission. Check the scan log before retrying.');}
    setTimeout(()=>{scannerBusy=false;},1300);
    setTimeout(()=>{if(Date.now()-lastAt>=4900&&!closed)showResult('','Ready to scan',service.meal?.name||'');},5000);
  }
  $('#startCamera').onclick=()=>guard(async()=>{if(!window.isSecureContext)throw new Error('Camera access requires HTTPS.');if(!window.MawayidCamera)throw new Error('Camera library did not load. Reload the page.');camera=new window.MawayidCamera('reader');try{await camera.start({facingMode:'environment'},{fps:20,qrbox:{width:220,height:220}},decoded=>submit(decoded),()=>{});$('#startCamera').disabled=true;}catch(err){camera=null;throw new Error('Camera could not start. Allow camera access, or use a USB scanner.');}});
  $('#manualScan').onsubmit=ev=>{ev.preventDefault();const input=$('#manualCode');submit(input.value.trim());input.value='';input.focus();};
  await update();
  scannerTimer=setInterval(async()=>{
    // Close locally at the exact server-aligned boundary; the server also checks every scan.
    if(service?.meal){const current=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Baghdad',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(Date.now()+serviceOffset));const [h,m]=current.split(':').map(Number);if(h*60+m>=service.meal.end&&!closed){closed=true;$('#manualSubmit').disabled=true;$('#startCamera').disabled=true;await stopScannerCamera();showResult('','Meal service closed','This meal period has ended.');}}
    if(Date.now()-(update.last||0)>15000){update.last=Date.now();await update();}
  },1000);
}
function showResult(color,title,detail){const box=$('#scanResult');if(!box)return;box.className=`scan-result ${color}`;box.innerHTML=`<strong>${e(title)}</strong><small>${e(detail)}</small>`;}
function beep(green){try{const context=new(window.AudioContext||window.webkitAudioContext)();const osc=context.createOscillator(),gain=context.createGain();osc.connect(gain);gain.connect(context.destination);osc.frequency.value=green?900:220;gain.gain.value=.1;osc.start();osc.stop(context.currentTime+.15);osc.onended=()=>context.close();}catch{}}
(async()=>{try{role=(await api('/session')).role;await route();}catch{login();}})();
