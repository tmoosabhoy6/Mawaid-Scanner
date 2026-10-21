'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, x => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[x]));
const e = escapeHtml;
let role, currentView = '', camera = null, service = null, scannerTimer = null, scannerBusy = false, printSettings = null;
const TIME_ZONE = 'Asia/Baghdad';
const dates = v => v ? new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:TIME_ZONE}).format(new Date(v)) : '—';
const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE}).format(new Date());
const longToday = () => new Intl.DateTimeFormat('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:TIME_ZONE}).format(new Date());
const number = n => new Intl.NumberFormat('en-GB').format(Number(n) || 0);
async function api(path, body) {
  const response = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type':'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== '/login') login(); throw Object.assign(new Error(result.error || 'Request failed.'), { status: response.status }); }
  return result;
}
function notify(message) { $('#notice').textContent = message; $('#notice').classList.add('visible'); clearTimeout(notify.timer); notify.timer = setTimeout(()=>$('#notice').classList.remove('visible'),7000); }
async function guard(fn) { try { await fn(); } catch (err) { notify(err.message); } }
async function busy(button, fn) { if (button.disabled) return; button.disabled = true; try { await fn(); } finally { button.disabled = false; } }
const LOGO = '/brand/faiz-e-husaini-logo-white.webp';
const brand = `<div class="brand"><img src="${LOGO}" alt="Faiz-e-Husaini Society (Iraq)" width="132" height="141"><strong>Mawaid</strong><span>Faiz-e-Husaini · Karbala</span></div>`;
const ornament = `<svg class="ornament" viewBox="0 0 200 18" aria-hidden="true"><path d="M0 9h82M118 9h82" stroke="currentColor" stroke-width="1" opacity=".55"/><g fill="none" stroke="currentColor" stroke-width="1.3"><rect x="94" y="3" width="12" height="12"/><rect x="94" y="3" width="12" height="12" transform="rotate(45 100 9)"/></g></svg>`;
async function stopScanner() { clearInterval(scannerTimer); scannerTimer = null; if (camera) { try { await camera.stop(); } catch {} camera = null; } }
function login() {
  stopScanner(); role = null;
  const scanner = location.pathname === '/scanner';
  $('#app').innerHTML = `<div class="login">${brand}<section class="panel"><h1>${scanner ? 'Meal scanner' : 'Mawaid printing system'}</h1><p>Sign in to ${scanner ? 'scan meal cards' : 'manage tours and print meal cards'}.</p><form id="loginForm"><label>Access<select name="role"><option value="${scanner?'scanner':'admin'}">${scanner?'Scanner':'Administrator'}</option><option value="${scanner?'admin':'scanner'}">${scanner?'Administrator':'Scanner'}</option></select></label><label>Password<input name="password" type="password" autocomplete="current-password" required autofocus></label><div class="error" id="loginError" role="alert"></div><button class="primary">Sign in</button></form><small>Cards are checked against each stay’s dates, in Karbala time.</small></section></div>`;
  $('#loginForm').onsubmit = async event => { event.preventDefault(); const f = new FormData(event.target); await busy($('button',event.target),async()=>{try { const data = await api('/login',Object.fromEntries(f)); role=data.role; await route(); } catch(err) { $('#loginError').textContent=err.message; } }); };
}
const navs = [['tours','▦','Tours'],['generate','＋','Add tour'],['prints','▤','Print log'],['logs','⌁','Scan log'],['summary','◫','Daily summary'],['settings','⚙','Settings']];
async function shell(view) {
  await stopScanner(); currentView=view;
  $('#app').innerHTML=`<div class="shell"><aside class="sidebar">${brand}${ornament}<nav class="nav" aria-label="Main">${navs.map(([key,icon,label])=>`<a href="#${key}" class="${key===view?'active':''}" ${key===view?'aria-current="page"':''}><span class="icon" aria-hidden="true">${icon}</span>${label}</a>`).join('')}</nav><div class="foot"><a class="scanner-link" href="/scanner" target="_blank" rel="noopener">Open meal scanner</a><small>Three meals. One card.</small></div></aside><div><header class="topbar"><span class="title">Mawaid printing system</span><span class="when"><span><b>${e(longToday())}</b> · Karbala</span><button id="topLogout">Sign out</button></span></header><main id="main"></main></div></div>`;
  $('#topLogout').onclick=logout;
}
async function logout(){ await guard(async()=>{await api('/logout',{});login();}); }
const heading=(title,desc,action='')=>`<div class="heading"><div><h1>${title}</h1><p>${desc}</p></div>${action}</div>`;
async function route(){
  if(!role)return;
  if(location.pathname==='/scanner'||role==='scanner')return scannerView();
  const view=location.hash.slice(1)||'tours'; await shell(view);
  await guard(async()=>{await ({tours:toursView,generate:generateView,prints:printsView,logs:logsView,summary:summaryView,settings:settingsView}[view]||toursView)();});
}
window.addEventListener('hashchange',route);
function printLogCell(t){
  if(!t.batch_id)return '<span class="chip">Not printed</span>';
  if(t.batch_status==='pdf_cleared')return '<span class="chip">PDF cleared</span>';
  if(t.batch_status==='awaiting_pdf')return '<a href="#prints">Finish in Print log</a>';
  return `<a href="/api/batches/${e(t.batch_id)}/pdf" target="_blank" rel="noopener">View PDF</a>`;
}
async function toursView(){
  $('#main').innerHTML=heading('Tours','Find an arrival date, select your tours, and print their meal cards.',`<button class="primary" id="newTour">＋ Add tour</button>`)+`<section class="panel"><form class="filters" id="tourFilters"><label>Arrival date<input type="date" name="arrival"></label><label>Tour ID, ITS or office<input name="q" placeholder="Search tours…"></label><button>Apply</button><button type="reset">Reset</button></form></section><section class="panel"><div class="tablebar"><span id="tourCount" class="count">Loading…</span><button class="primary" id="printSelected" disabled>Print selected</button></div><div class="tablewrap" id="tourTable"></div></section>`;
  $('#newTour').onclick=()=>location.hash='generate';
  let safaris=[];
  const tourRow=t=>`<tr><td><input class="tour-check" type="checkbox" value="${e(t.id)}" aria-label="Select tour ${e(t.tour_id||t.office)}" ${t.issued>=t.pax?'disabled':''}></td><td><strong>${e(t.tour_id||'—')}</strong></td><td>${e(t.its||'—')}</td><td>${e(t.office)}</td><td>${e(t.arrival)}</td><td>${e(t.departure)}</td><td>${e(t.pax)} <small>· ${e(t.issued)} issued</small></td><td>${printLogCell(t)}</td><td><button class="replace" data-tour="${e(t.id)}" ${!t.issued?'disabled':''}>Replace cards</button></td></tr>`;
  // A Safari card always prints as its QR-free sticker and can be printed again at any time.
  const safariRow=s=>`<tr><td><input class="safari-check" type="checkbox" value="${e(s.id)}" aria-label="Select Safari ${e(s.office||s.tour_id||'card')}"></td><td>${s.tour_id?`<strong>${e(s.tour_id)}</strong> `:''}<span class="chip safari-chip">Safari</span></td><td>${e(s.its||'—')}</td><td>${e(s.office||'—')}</td><td>${e(s.arrival||'—')}</td><td>${e(s.departure||'—')}</td><td>${e(s.pax??'—')}</td><td><button class="print-safari" data-safari="${e(s.id)}">Print sticker</button></td><td><span class="muted">No QR code</span></td></tr>`;
  const load=async()=>{const params=new URLSearchParams(new FormData($('#tourFilters')));let tours;[tours,safaris]=await Promise.all([api(`/tours?${params}`),api(`/safaris?${params}`)]);
    // Stable sort: Safari cards follow the tours arriving on the same day; undated cards come last.
    const rows=[...tours,...safaris.map(s=>({...s,safari:true}))].sort((a,b)=>(a.arrival||'~').localeCompare(b.arrival||'~'));
    $('#tourCount').textContent=`${number(tours.length)} tour${tours.length===1?'':'s'}${safaris.length?` · ${number(safaris.length)} Safari`:''}`;
    $('#tourTable').innerHTML=rows.length?`<table><thead><tr><th><input type="checkbox" id="allTours" aria-label="Select all unprinted tours"></th><th>Tour ID</th><th>ITS</th><th>Office</th><th>Arrival</th><th>Departure</th><th>PAX</th><th>Print log</th><th>Lost cards</th></tr></thead><tbody>${rows.map(r=>r.safari?safariRow(r):tourRow(r)).join('')}</tbody></table>`:`<div class="empty"><h2>No tours to show</h2><p>Add a tour, or connect your Google Sheet in Settings.</p></div>`;
    const update=()=>{$('#printSelected').disabled=!$$('.tour-check:checked, .safari-check:checked').length;};
    if($('#allTours'))$('#allTours').onchange=event=>{$$('.tour-check:not(:disabled)').forEach(c=>c.checked=event.target.checked);update();};
    $$('.tour-check, .safari-check').forEach(c=>c.onchange=update);$$('.replace').forEach(b=>b.onclick=()=>guard(()=>replaceCards(b.dataset.tour)));
    $$('.print-safari').forEach(b=>b.onclick=()=>guard(()=>busy(b,()=>printSafaris(safaris.filter(s=>s.id===b.dataset.safari)))));update();
  };
  $('#tourFilters').onsubmit=ev=>{ev.preventDefault();guard(load);};$('#tourFilters').onreset=()=>setTimeout(()=>guard(load),0);
  $('#printSelected').onclick=()=>guard(async()=>{await busy($('#printSelected'),async()=>{
    const tourIds=$$('.tour-check:checked').map(c=>c.value),picked=$$('.safari-check:checked').map(c=>c.value);
    if(picked.length)await printSafaris(safaris.filter(s=>picked.includes(s.id)));
    if(tourIds.length)await createLabels({tourIds});
  });await load();});
  await load();
}
async function generateView(){
  $('#main').innerHTML=heading('Add tour','Create meal cards for people who are not in the Google Sheet.')+`<section class="panel"><form class="form" id="addTour"><div class="grid"><label><span>Tour ID <small>(optional)</small></span><input name="tour_id" maxlength="80" placeholder="e.g. 26/3205"></label><label><span>ITS <small>(optional)</small></span><input name="its" maxlength="40" inputmode="numeric" placeholder="ITS number"></label><label>Office name<input name="office" maxlength="160" required placeholder="Tour office"></label><label>Number of people (PAX)<input name="pax" type="number" min="1" max="10000" step="1" required></label><label>Arrival date<input name="arrival" type="date" required></label><label>Departure date<input name="departure" type="date" required></label></div><div class="helper">Each person gets one QR card for breakfast, lunch and dinner throughout their stay. If this tour already exists for the same arrival date, use <strong>Replace cards</strong> for lost cards; meal limits stay the same.</div><div class="actions"><button type="submit" name="action" value="save">Submit</button><button type="submit" class="primary" name="action" value="print">Submit &amp; print</button></div></form></section><section class="panel"><h2>Safari</h2><p>Takeaway lunch and dinner. One sticker covers the whole stay and has no QR code. Every field is optional; a blank date or PAX prints as a line to write on.</p><form class="form" id="addSafari"><div class="grid"><label>Office or tour name<input name="office" maxlength="160" placeholder="e.g. Izan Caravan"></label><label>Packs (PAX)<input name="pax" type="number" min="1" max="10000" step="1"></label><label>Arrival date<input name="arrival" type="date"></label><label>Departure date<input name="departure" type="date"></label><label>Tour ID<input name="tour_id" maxlength="80"></label><label>ITS<input name="its" maxlength="40" inputmode="numeric"></label></div><div class="helper">Safari cards always print as the Lunch/Dinner sticker without a QR code, here and from the Tours page. The tour ID and ITS help you find the card later; they are not printed.</div><div class="actions"><button type="submit" name="action" value="save">Submit</button><button type="submit" class="primary" name="action" value="print">Submit &amp; print</button></div></form></section>`;
  $('#addSafari').onsubmit=ev=>{ev.preventDefault();const action=ev.submitter.value;const button=ev.submitter;guard(()=>busy(button,async()=>{const safari=await api('/safaris',Object.fromEntries(new FormData(ev.target)));notify('Safari card added.');if(action==='print')await printSafaris([safari]);location.hash='tours';}));};
  $('#addTour').onsubmit=ev=>{ev.preventDefault();const action=ev.submitter.value;const button=ev.submitter;guard(()=>busy(button,async()=>{const result=await api('/tours',Object.fromEntries(new FormData(ev.target)));if(result.existing){notify('This stay already exists. Choose the people whose cards were lost.');await replaceCards(result.id);return;}notify('Tour added.');if(action==='print')await createLabels({tourIds:[result.id]});location.hash='tours';}));};
}
async function replaceCards(tourId){
  window.mawaidBatchLimit=(await api('/settings')).maxLabels||500;
  const people=await api(`/tours/${tourId}/people`);
  $('#peopleContent').innerHTML=`<h2>Replace lost cards</h2><p>Choose each person whose card was lost. Their old QR stops working; meals they already had stay used. There is no limit on replacements.</p><div class="person-list">${people.map(p=>`<label><input type="checkbox" value="${e(p.id)}"> Person ${e(p.person_no)}</label>`).join('')}</div><button class="primary" id="replaceSelected">Replace &amp; print selected</button><p class="status-note">Up to ${window.mawaidBatchLimit||500} labels print in one job.</p>`;
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
function loadPdfLibrary(){
  if(!pdfLibraryPromise)pdfLibraryPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/vendor/pdf.js';script.onload=resolve;script.onerror=()=>{pdfLibraryPromise=null;script.remove();reject(new Error('The PDF library could not load. Please try again.'));};document.head.appendChild(script);});
  return pdfLibraryPromise;
}
async function finishPdf(batch){
  if(!batch.requiresPdfUpload)return;
  if(!batch.cards)batch=await api(`/batches/${batch.id}/manifest`);
  await loadPdfLibrary();
  notify('Generating labels on this computer…');
  const pdf=await window.generateMawaidPdf(batch.cards,batch.printer);
  const response=await fetch(`/api/batches/${batch.id}/pdf`,{method:'POST',headers:{'Content-Type':'application/pdf'},body:pdf});
  if(!response.ok){const result=await response.json();throw new Error(result.error||'The PDF could not be saved. Use Finish PDF in Print log.');}
}
async function sendToPrinter(bytes,settings,jobName){
  if(!window.qz)throw new Error('Printer library did not load. Reload the page.');
  if(!qz.websocket.isActive())await qz.websocket.connect();
  const printerName=await qz.printers.find(settings.name);
  let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
  const config=qz.configs.create(printerName,{size:{width:settings.widthMm,height:settings.heightMm},units:'mm',colorType:'blackwhite',scaleContent:false,margins:0,jobName});
  await qz.print(config,[{type:'pixel',format:'pdf',flavor:'base64',data:btoa(binary)}]);
}
async function printBatch(id){
  try {
    printSettings=(await api('/settings')).printer;
    if(!window.qz)throw new Error('Printer library did not load. Reload the page.');
    const response=await fetch(`/api/batches/${id}/pdf`);if(!response.ok)throw new Error('Could not fetch the saved label PDF.');
    await sendToPrinter(new Uint8Array(await response.arrayBuffer()),printSettings,'Mawaid meal cards');
    await api(`/batches/${id}/status`,{status:'sent_to_printer'});notify('Job sent to the Zebra printer. Check the physical labels.');return true;
  } catch(err) {
    await api(`/batches/${id}/status`,{status:'printer_error'}).catch(()=>{});
    notify(`PDF saved. Printer connection needs attention: ${err.message}. Open Print log to retry.`);return false;
  }
}
// Safari stickers have no QR code, so nothing is issued or saved: they are drawn on this computer and printed straight away.
async function printSafaris(safaris){
  if(!safaris.length)return;
  notify('Preparing Safari stickers…');
  await loadPdfLibrary();
  const settings=(await api('/settings')).printer,pdf=await window.generateSafariPdf(safaris,settings);
  const what=safaris.length===1?'Safari sticker':`${safaris.length} Safari stickers`;
  try{await sendToPrinter(new Uint8Array(await pdf.arrayBuffer()),settings,'Mawaid Safari stickers');notify(`${what} sent to the Zebra printer. Check the physical labels.`);}
  catch(err){notify(`The ${what} could not be printed: ${err.message}. Use Print sticker on the Tours page to try again.`);}
}
const printStatus = { generated:'PDF saved', awaiting_pdf:'Waiting for PDF', sent_to_printer:'Sent to printer', printer_error:'Printer error', pdf_cleared:'PDF cleared' };
async function printsView(){
  const batches=await api('/batches');
  $('#main').innerHTML=heading('Print log','Every label PDF is saved here. Printing a PDF again uses the same QR codes.')+`<section class="panel tablewrap">${batches.length?`<table><thead><tr><th>Created · Karbala</th><th>Type</th><th>Labels</th><th>Status</th><th>Saved PDF</th><th>Action</th></tr></thead><tbody>${batches.map(b=>{const cleared=b.printer_status==='pdf_cleared',pending=b.pdf_ready===0&&!cleared;return `<tr><td>${e(dates(b.created_at))}</td><td>${b.kind==='replacement'?'Replacement':'New cards'}</td><td>${e(b.count)} <small>· ${e(b.active_count)} active</small></td><td><span class="chip ${b.printer_status==='printer_error'?'red-chip':b.printer_status==='sent_to_printer'?'green-chip':''}">${e(printStatus[b.printer_status]||b.printer_status.replaceAll('_',' '))}</span></td><td>${cleared?'<span class="muted">Cleared after the stay</span>':pending?'<span class="chip">PDF pending</span>':`<a href="/api/batches/${e(b.id)}/pdf" target="_blank" rel="noopener">View PDF</a>`}</td><td><button class="retry-print" data-pending="${pending}" data-id="${e(b.id)}" ${!b.active_count||cleared?'disabled':''}>${pending?'Finish PDF':'Print PDF'}</button></td></tr>`;}).join('')}</tbody></table>`:'<div class="empty"><h2>No label PDFs yet</h2><p>Select tours on the Tours page and choose Print selected.</p></div>'}</section><p>Older PDFs can include replaced QR codes; printing them again does not reactivate those codes. “Sent to printer” means QZ Tray accepted the job; check that the labels came out.</p>`;
  $$('.retry-print').forEach(b=>b.onclick=()=>guard(()=>busy(b,async()=>{if(b.dataset.pending==='true'){await finishPdf(await api(`/batches/${b.dataset.id}/manifest`));await printsView();}else await printBatch(b.dataset.id);})));
}
async function logsView(){
  $('#main').innerHTML=heading('Scan log','Every admission and declined scan, from every scanner.')+`<section class="panel"><form class="filters" id="logFilters"><label>Date<input type="date" name="date" value="${today()}"></label><label>Tour ID<input name="tour"></label><label>Office<input name="office"></label><label>Result<select name="status"><option value="">All</option><option value="green">Green · admitted</option><option value="red">Red · declined</option></select></label><button>Apply</button><button type="reset">Reset</button></form></section><section class="panel tablewrap" id="logTable"></section>`;
  const load=async()=>{const rows=await api(`/logs?${new URLSearchParams(new FormData($('#logFilters')))}`);$('#logTable').innerHTML=rows.length?`<table><thead><tr><th>Time · Karbala</th><th>Tour ID</th><th>Office</th><th>Person</th><th>Result</th><th>Reason</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${e(dates(r.scanned_at))}</td><td>${e(r.display_tour||'—')}</td><td>${e(r.office||'—')}</td><td>${e(r.person_no||'—')}</td><td><span class="chip ${r.reason==='admitted'?'green-chip':'red-chip'}">${r.reason==='admitted'?'Green':'Red'}</span></td><td>${e(r.reason.replaceAll('_',' '))}</td></tr>`).join('')}</tbody></table><p class="status-note">Showing the latest ${number(1000)} matching scans.</p>`:'<div class="empty"><h2>No scans match</h2><p>Try another date or clear the filters.</p></div>';};
  $('#logFilters').onsubmit=ev=>{ev.preventDefault();guard(load);};$('#logFilters').onreset=()=>setTimeout(()=>guard(load),0);await load();
}
async function summaryView(){
  $('#main').innerHTML=heading('Daily summary','Green scans for each tour staying on this date. Cards are not limited by meal, so a person can scan more than once.')+`<section class="panel"><form class="filters" id="summaryFilters"><label>Date<input type="date" name="date" value="${today()}"></label><button>Apply</button></form></section><div id="summaryContent"></div>`;
  const load=async()=>{const rows=await api(`/summary?${new URLSearchParams(new FormData($('#summaryFilters')))}`);const total=key=>rows.reduce((sum,r)=>sum+Number(r[key]),0);$('#summaryContent').innerHTML=`<div class="metric-row"><div class="metric"><span>People scanned</span><strong>${number(total('people'))}</strong><small>of ${number(total('pax'))} people staying</small></div><div class="metric"><span>Green scans</span><strong>${number(total('scans'))}</strong><small>across ${number(rows.length)} tour${rows.length===1?'':'s'}</small></div></div><section class="panel tablewrap">${rows.length?`<table><thead><tr><th>Tour</th><th>Office</th><th>PAX</th><th>People scanned</th><th>Green scans</th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${e(r.tour_id||'—')}</strong></td><td>${e(r.office)}</td><td>${e(r.pax)}</td><td>${e(r.people)}</td><td>${e(r.scans)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty"><h2>No one staying on this date</h2><p>Choose another date.</p></div>'}</section>`;};
  $('#summaryFilters').onsubmit=ev=>{ev.preventDefault();guard(load);};await load();
}
const megabytes = bytes => `${(bytes/1e6).toFixed(1)} MB`;
async function settingsView(){
  const settings=await api('/settings'),p=settings.printer,s=settings.source;window.mawaidBatchLimit=settings.maxLabels||500;
  const free=settings.hosting==='cloudflare-free',limit=settings.databaseLimitBytes||500e6,used=settings.databaseBytes||0,share=Math.min(100,used/limit*100);
  $('#main').innerHTML=heading('Settings','Storage, your Google Sheet and the Zebra ZD220D printer.')+`<section class="panel" id="storagePanel"><h2>${free?'Free hosting storage':'Database storage'}</h2>${free?`<div class="storage-figures"><span><b>${megabytes(used)}</b> used</span><span>${megabytes(limit)} limit</span></div><div class="meter ${share>=90?'full':share>=70?'high':''}" role="meter" aria-label="Database storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${share.toFixed(0)}"><i style="width:${share.toFixed(1)}%"></i></div>`:`<div class="storage-figures"><span><b>${megabytes(used)}</b> used</span></div>`}<p>Scan history and saved label PDFs use this space. Archive older records to this computer, then clear them here. Nothing is ever deleted automatically.</p><form class="clear-form" id="clearForm"><label>Clear records from before<input type="date" name="before" value="${today()}" max="${today()}" required></label><ul class="ready-list" id="readyList" aria-live="polite"><li>Counting records…</li></ul><p class="status-note">Today’s meals and anyone still staying are never affected. Each archive is a folder of spreadsheets (CSV): scans, meals served, a daily meal summary, tours, cards and print jobs. Label PDFs are not included.</p><div class="actions"><button type="submit" class="primary" id="archiveClear">Archive &amp; clear</button><button type="button" class="danger" id="deleteRecords" disabled>Delete without archiving</button></div><div class="folder-line" id="folderLine"></div><p class="archive-progress" id="archiveProgress" role="status"></p><p class="status-note" id="allowanceNote"></p></form></section><section class="panel"><h2>Google Sheet</h2><p>Pehli Ziyarat is the arrival date. Departure is the day after Wada Ziyarat. The separate ToursSync Apps Script sends updates to this app; the existing flatten function and trigger stay in place.</p><form class="form" id="sourceSettings"><label>Google Sheet URL<input name="url" value="https://docs.google.com/spreadsheets/d/${e(s.spreadsheetId)}/edit" required></label><div class="grid"><label>Source tab<input name="tab" list="sourceTabs" value="${e(s.tab)}" required><datalist id="sourceTabs">${(settings.sync?.tabs||[]).map(t=>`<option value="${e(t)}">`).join('')}</datalist></label><div><small>Tab names appear after the first successful sync.</small></div></div><label>Daily sync times in Karbala (optional)<input name="dailyTimes" value="${e((s.dailyTimes||[]).join(', '))}" placeholder="Leave blank for every 5 minutes, or 06:00, 12:00, 18:00"></label><div class="actions"><button>Save sheet connection</button><button type="button" id="requestSync">Request sync</button></div></form><p class="status-note">${settings.sync?`Last successful sync: ${e(dates(settings.sync.lastSuccess))} · ${e(settings.sync.imported)} stays`:'No sync received yet. Install apps-script/ToursSync.js and run its setup function.'}</p>${(settings.sync?.warnings||[]).map(w=>`<p class="warning-note">${e(w)}</p>`).join('')}</section><section class="panel"><h2>Zebra ZD220D</h2><p>Install QZ Tray and the Zebra driver on the USB-connected printing computer, and open this app on that computer. Your stickers are 3 inches wide × 2 inches high (76.2 × 50.8 mm).</p><form class="form" id="printerSettings"><label>Printer name (as shown by the computer)<input name="name" value="${e(p.name)}" required></label><div class="grid"><label>Label width (mm)<input type="number" name="widthMm" min="40" max="104" step="0.1" value="${e(p.widthMm)}" required></label><label>Label height (mm)<input type="number" name="heightMm" min="50.8" max="200" step="0.1" value="${e(p.heightMm)}" required></label></div><small>${p.confirmed?'Label size confirmed.':'Save the printer settings to confirm this label size.'} Labels below 80 mm high need a width of at least 70 mm.</small><div class="actions"><button>Confirm &amp; save printer settings</button></div></form><p class="status-note">Saved PDFs show the Karbala calligraphy in maroon. The ZD220D prints in black only. QZ Tray may ask you to approve this site; fully silent printing needs a trusted QZ certificate.</p></section><section class="panel"><h2>Meal scanner</h2><p>Cards are checked at any time of day, using the Karbala date. <b>Green</b>: a recognised card on any day from arrival to departure, both included. <b>Red</b>: an unknown or replaced card, a date outside the stay, a tour no longer in the Google Sheet, or a person above the tour’s PAX. Safari stickers have no QR code and are not scanned.</p><a href="/scanner" target="_blank" rel="noopener">Open the meal scanner</a></section>`;
  $('#sourceSettings').onsubmit=ev=>{ev.preventDefault();guard(async()=>{const f=new FormData(ev.target),id=String(f.get('url')).match(/\/spreadsheets\/d\/([\w-]+)/)?.[1];if(!id)throw new Error('Enter a Google Sheets URL.');await api('/settings',{source:{spreadsheetId:id,tab:f.get('tab'),dailyTimes:String(f.get('dailyTimes')||'').split(',').map(t=>t.trim()).filter(Boolean)}});notify('Sheet connection saved. Use the same tab in the separate Apps Script.');});};
  $('#requestSync').onclick=()=>guard(async()=>{await api('/sync/request',{});notify('Sync requested. The separate Apps Script will send it on its next five-minute run.');});
  $('#printerSettings').onsubmit=ev=>{ev.preventDefault();guard(async()=>{const f=new FormData(ev.target);await api('/settings',{printer:{name:f.get('name'),widthMm:Number(f.get('widthMm')),heightMm:Number(f.get('heightMm'))}});notify('Printer settings confirmed.');});};
  storageControls();
}
/* Archive & clear: records are copied to this computer first, then removed in small server-side chunks. */
const ARCHIVE_ROOT = 'Mawaid Archive';
function storageControls(){
  const form=$('#clearForm'),input=$('[name=before]',form);let counts=null;
  const refresh=async()=>{
    $('#readyList').innerHTML='<li>Counting records…</li>';
    const status=await api(`/archive?before=${encodeURIComponent(input.value)}`);counts=status.counts;
    $('#readyList').innerHTML=`<li><b>${number(counts.scans)}</b>scan records</li><li><b>${number(counts.meals)}</b>meals served</li><li><b>${number(counts.pdfs)}</b>label PDFs from finished stays</li>`;
    $('#deleteRecords').disabled=!(counts.scans||counts.meals||counts.pdfs);
    const c=status.cleanup;
    $('#allowanceNote').textContent=c?`Clearing uses part of the free plan’s daily allowance (${number(Math.max(0,c.limit-c.used))} of ${number(c.limit)} left today). A very large clean-up pauses and continues after 3:00 am Karbala time.`:'';
  };
  const showFolder=async()=>{
    if(!window.showDirectoryPicker){$('#folderLine').innerHTML='<span>This browser downloads each archive as a .zip file. Use Chrome or Edge to save archives straight into a folder.</span>';return;}
    const saved=await savedFolder();
    $('#folderLine').innerHTML=saved?`<span>Archives are saved to <b>${e(saved.parent?`${saved.parent} › `:'')}${ARCHIVE_ROOT}</b></span><button type="button" class="link-button" id="changeFolder">Change folder</button>`:`<span>The first archive asks where to create the <b>${ARCHIVE_ROOT}</b> folder.</span>`;
    if($('#changeFolder'))$('#changeFolder').onclick=()=>guard(async()=>{try{await archiveFolder(true);}catch(err){if(err.name!=='AbortError')throw err;}await showFolder();});
  };
  input.onchange=()=>guard(refresh);
  form.onsubmit=ev=>{ev.preventDefault();guard(()=>busy($('#archiveClear'),async()=>{$('#deleteRecords').disabled=true;try{await archiveAndClear(input.value);}finally{await showFolder();await refresh();}}));};
  $('#deleteRecords').onclick=()=>guard(async()=>{if(!counts)return;const before=input.value;
    $('#peopleContent').innerHTML=`<h2>Delete records permanently?</h2><p>This removes ${number(counts.scans)} scan records, ${number(counts.meals)} meals served and ${number(counts.pdfs)} label PDFs from before ${e(before)}. Nothing is saved to this computer, and this can’t be undone.</p><div class="dialog-actions"><button type="button" id="cancelDelete">Keep records</button><button type="button" class="danger solid" id="confirmDelete">Delete records</button></div>`;
    $('#peopleDialog').showModal();$('#cancelDelete').onclick=()=>$('#peopleDialog').close();
    $('#confirmDelete').onclick=()=>guard(async()=>{$('#peopleDialog').close();$('#deleteRecords').disabled=true;try{await clearRecords(before,'Deleted');}finally{await refresh();}});
  });
  return guard(async()=>{await showFolder();await refresh();});
}
function progress(text){const line=$('#archiveProgress');if(line)line.textContent=text;}
async function archiveAndClear(before){
  let target;
  // Ask for folder access first, while the click still counts as a user action.
  try{target=await archiveFolder(false);}catch(err){if(err.name==='AbortError'){progress('Archive cancelled. Nothing was cleared.');return;}throw err;}
  const data={};
  for(const [key,label] of [['scans','scan records'],['meals','meals served'],['tours','tours'],['cards','cards'],['prints','print jobs']]){
    data[key]=[];let after=0;
    for(;;){const page=await api(`/archive/${key}?before=${encodeURIComponent(before)}&after=${after}`);data[key].push(...page.rows);progress(`Collecting ${label}… ${number(data[key].length)}`);if(page.next==null)break;after=page.next;}
  }
  const name=archiveName(),files=archiveFiles(data,before,name);
  progress('Saving archive files…');
  if(target){const dir=await uniqueFolder(target.handle,name);for(const [file,text] of files)await writeFile(dir,file,text);progress(`Archive saved to ${ARCHIVE_ROOT} › ${dir.name}.`);}
  else{downloadZip(`${ARCHIVE_ROOT} - ${name}.zip`,files.map(([file,text])=>[`${ARCHIVE_ROOT}/${name}/${file}`,text]));progress('Archive downloaded as a .zip file.');}
  await clearRecords(before,'Archived and cleared');
}
async function clearRecords(before,verb){
  const total={scans:0,meals:0,pdfs:0};
  const summary=()=>`${number(total.scans)} scan records, ${number(total.meals)} meals served and ${number(total.pdfs)} label PDFs`;
  for(;;){
    let result;
    try{result=await api('/archive/clear',{before});}
    catch(err){if(err.status===429){progress(`${verb} ${summary()} so far. ${err.message}`);return;}throw err;}
    for(const k in total)total[k]+=result.deleted[k];
    progress(`Clearing… ${summary()}`);
    if(result.done)break;
  }
  progress(`${verb} ${summary()}.`);notify(`${verb} ${summary()}.`);
}
function archiveName(){
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date()).map(x=>[x.type,x.value]));
  return `Archive ${p.year}-${p.month}-${p.day} ${p.hour}.${p.minute}`;
}
const karbalaTime = v => v ? new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(v)).replace(', ',' ') : '';
const mealName = m => m ? m[0].toUpperCase()+m.slice(1) : '';
// Spreadsheet-safe CSV: text that starts like a formula is kept as plain text.
const csvCell = v => { let s=String(v??''); if(/^[=+\-@\t\r]/.test(s))s=`'${s}`; return /[",\r\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s; };
const csv = (head,rows) => `﻿${[head,...rows].map(r=>r.map(csvCell).join(',')).join('\r\n')}\r\n`;
function archiveFiles(d,before,name){
  const pax=new Map(d.tours.map(t=>[t.tour_key,t.pax])),daily=new Map();
  for(const m of d.meals){const key=`${m.date}|${m.tour_key}`;const row=daily.get(key)||{date:m.date,tour_id:m.tour_id,office:m.office,pax:pax.get(m.tour_key)??'',breakfast:0,lunch:0,dinner:0};row[m.meal]++;daily.set(key,row);}
  const summary=[...daily.values()].sort((a,b)=>a.date.localeCompare(b.date)||String(a.tour_id).localeCompare(String(b.tour_id)));
  return [
    ['scan-log.csv',csv(['Time (Karbala)','Service date','Meal','Tour ID','Office','Person','Result','Reason'],d.scans.map(r=>[karbalaTime(r.scanned_at),r.date,mealName(r.meal),r.tour_id,r.office,r.person_no,r.reason==='admitted'?'Admitted':'Declined',r.reason.replaceAll('_',' ')]))],
    ['meals-served.csv',csv(['Service date','Meal','Tour ID','Office','Person','Scanned (Karbala)'],d.meals.map(r=>[r.date,mealName(r.meal),r.tour_id,r.office,r.person_no,karbalaTime(r.scanned_at)]))],
    ['daily-meal-summary.csv',csv(['Service date','Tour ID','Office','PAX','Breakfast','Lunch','Dinner'],summary.map(r=>[r.date,r.tour_id,r.office,r.pax,r.breakfast,r.lunch,r.dinner]))],
    ['tours.csv',csv(['Tour ID','ITS','Office','Arrival','Departure','PAX','Cards issued','Source','Active','Added (Karbala)'],d.tours.map(t=>[t.tour_id,t.its,t.office,t.arrival,t.departure,t.pax,t.issued,t.source==='sheets'?'Google Sheet':'Added manually',t.active?'Yes':'No',karbalaTime(t.created_at)]))],
    ['cards.csv',csv(['Tour ID','Office','Arrival','Person','Card printed (Karbala)','Replaced (Karbala)','Print job'],d.cards.map(c=>[c.tour_id,c.office,c.arrival,c.person_no,karbalaTime(c.created_at),karbalaTime(c.revoked_at),c.batch_id]))],
    ['print-log.csv',csv(['Created (Karbala)','Type','Labels','Status','PDF','Print job'],d.prints.map(b=>[karbalaTime(b.created_at),b.kind==='replacement'?'Replacement':'New cards',b.labels,printStatus[b.printer_status]||b.printer_status,b.printer_status==='pdf_cleared'?'Cleared':b.pdf_saved?'Saved in app':'Pending',b.batch_id]))],
    ['read-me.txt',`Mawaid archive · Faiz-e-Husaini Karbala\r\n${name} (Karbala time)\r\n\r\nScan records and meals served are from before ${before}. Tours, cards and print jobs are a full copy of what the app held at this time.\r\nLabel PDFs are not included. Times are Karbala time (Asia/Baghdad).\r\n\r\nscan-log.csv            ${d.scans.length} scans, admitted and declined\r\nmeals-served.csv        ${d.meals.length} meals served\r\ndaily-meal-summary.csv  meals served per tour per day\r\ntours.csv               ${d.tours.length} tours\r\ncards.csv               ${d.cards.length} cards, including replaced cards\r\nprint-log.csv           ${d.prints.length} print jobs\r\n`],
  ];
}
// The chosen folder is remembered in this browser so later archives go to the same place.
function folderStore(mode,fn){return new Promise((resolve,reject)=>{if(!window.indexedDB)return reject(new Error('No browser storage.'));const open=indexedDB.open('mawaid',1);open.onupgradeneeded=()=>open.result.createObjectStore('handles');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const tx=open.result.transaction('handles',mode),req=fn(tx.objectStore('handles'));tx.oncomplete=()=>{open.result.close();resolve(req.result);};tx.onerror=()=>{open.result.close();reject(tx.error);};};});}
const savedFolder=()=>folderStore('readonly',s=>s.get('archiveFolder')).catch(()=>null);
async function archiveFolder(choose){
  if(!window.showDirectoryPicker)return null;
  const saved=!choose&&await savedFolder();
  if(saved){const mode={mode:'readwrite'};if(await saved.handle.queryPermission(mode)==='granted'||await saved.handle.requestPermission(mode)==='granted')return saved;}
  const picked=await window.showDirectoryPicker({id:'mawaid-archive',mode:'readwrite',startIn:'documents'});
  const inside=picked.name===ARCHIVE_ROOT,folder={handle:inside?picked:await picked.getDirectoryHandle(ARCHIVE_ROOT,{create:true}),parent:inside?'':picked.name};
  await folderStore('readwrite',s=>s.put(folder,'archiveFolder')).catch(()=>{});
  return folder;
}
async function uniqueFolder(root,name){
  for(let n=1;;n++){const candidate=n===1?name:`${name} (${n})`;try{await root.getDirectoryHandle(candidate);}catch(err){if(err.name==='NotFoundError')return root.getDirectoryHandle(candidate,{create:true});throw err;}}
}
async function writeFile(dir,name,text){const file=await dir.getFileHandle(name,{create:true}),stream=await file.createWritable();await stream.write(text);await stream.close();}
// Minimal stored (uncompressed) ZIP for browsers without folder access.
const crcTable=Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xEDB88320^(n>>>1):n>>>1;return n>>>0;});
const crc32=bytes=>{let c=0xFFFFFFFF;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xFFFFFFFF)>>>0;};
function zipBlob(entries){
  const encoder=new TextEncoder(),now=new Date(),time=(now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1),day=((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
  const put=(view,fields)=>fields.forEach(([at,value,size])=>size===4?view.setUint32(at,value,true):view.setUint16(at,value,true));
  const parts=[],central=[];let offset=0;
  for(const [path,text] of entries){
    const name=encoder.encode(path),data=encoder.encode(text),crc=crc32(data),local=new DataView(new ArrayBuffer(30)),dir=new DataView(new ArrayBuffer(46));
    put(local,[[0,0x04034b50,4],[4,20,2],[6,0x0800,2],[8,0,2],[10,time,2],[12,day,2],[14,crc,4],[18,data.length,4],[22,data.length,4],[26,name.length,2],[28,0,2]]);
    put(dir,[[0,0x02014b50,4],[4,20,2],[6,20,2],[8,0x0800,2],[10,0,2],[12,time,2],[14,day,2],[16,crc,4],[20,data.length,4],[24,data.length,4],[28,name.length,2],[30,0,2],[32,0,2],[34,0,2],[36,0,2],[38,0,4],[42,offset,4]]);
    parts.push(local,name,data);central.push(dir,name);offset+=30+name.length+data.length;
  }
  const size=central.reduce((n,p)=>n+p.byteLength,0),end=new DataView(new ArrayBuffer(22));
  put(end,[[0,0x06054b50,4],[8,entries.length,2],[10,entries.length,2],[12,size,4],[16,offset,4]]);
  return new Blob([...parts,...central,end],{type:'application/zip'});
}
function downloadZip(filename,entries){const url=URL.createObjectURL(zipBlob(entries)),a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
async function scannerView(){
  await stopScanner();currentView='scanner';
  $('#app').innerHTML=`<div class="scanner-shell"><header class="scanner-head"><h1><img src="${LOGO}" alt="" width="44" height="47">Mawaid scanner</h1><button id="scannerLogout">Sign out</button></header><small>Faiz-e-Husaini Karbala · Karbala time</small><div class="scan-result" id="scanResult" role="status" aria-live="assertive"><strong>Connecting…</strong></div><div class="camera-box" id="reader"></div><button class="primary" id="startCamera">Start camera</button><p class="scan-tip" id="scanTip">Hold one QR inside the frame. Wait for the result before admitting anyone.</p><details class="manual"><summary>Use a USB scanner or enter a QR value</summary><form id="manualScan"><input id="manualCode" aria-label="QR code value" placeholder="MW1:…" autocomplete="off" required><button id="manualSubmit">Scan</button></form></details><p class="status-note" id="scannerStatus"></p>${role==='admin'?'<a href="/">Back to printing system</a>':''}</div>`;
  $('#scannerLogout').onclick=logout;
  // Cards are checked at any time of day: green is a recognised card within its stay dates.
  let lastCode='',lastAt=0;
  const ready=()=>{if(!scannerBusy&&Date.now()-lastAt>=5000)showResult('','Ready to scan',service?`Cards are checked for ${service.date}`:'');};
  const update=async()=>{
    try{service=await api('/service');$('#scannerStatus').textContent=`${service.date} · Device connected`;ready();}
    catch(err){$('#scannerStatus').textContent='Connection unavailable';showResult('red','Connection unavailable','Admission is blocked until the server is reachable.');}
  };
  const cameraButton=()=>{$('#startCamera').textContent=camera?'Stop camera':'Start camera';$('#startCamera').classList.toggle('primary',!camera);};
  async function stopScannerCamera(){if(camera){const running=camera;camera=null;try{await running.stop();}catch{}try{running.clear();}catch{}}cameraButton();}
  async function submit(code){
    if(scannerBusy)return; if(code===lastCode&&Date.now()-lastAt<3000)return;
    scannerBusy=true;lastCode=code;lastAt=Date.now();
    showResult('','Checking card…','Please wait for the result.');
    try{const result=await api('/scan',{code,requestKey:crypto.randomUUID()});showResult(result.status,result.status==='green'?'ALLOW':'DO NOT ADMIT',result.message+(result.person_no?` · Person ${result.person_no}`:''));beep(result.status==='green');}
    catch(err){showResult('red','DO NOT ADMIT','No confirmed admission. Check the scan log before retrying.');beep(false);}
    setTimeout(()=>{scannerBusy=false;},1300);
    setTimeout(()=>{if(Date.now()-lastAt>=4900)ready();},5000);
  }
  $('#startCamera').onclick=()=>guard(()=>busy($('#startCamera'),async()=>{
    if(camera)return stopScannerCamera();
    if(!window.isSecureContext)throw new Error('Camera access requires HTTPS.');if(!window.MawaidCamera)throw new Error('Camera library did not load. Reload the page.');
    const starting=new window.MawaidCamera('reader');
    try{await starting.start({facingMode:'environment'},{fps:20,qrbox:{width:220,height:220}},decoded=>submit(decoded),()=>{});}
    catch(err){try{starting.clear();}catch{}throw new Error(/NotAllowed|Permission/i.test(String(err?.name||err))?'Camera access was blocked. Allow the camera for this site in your browser settings, then try again.':'The camera could not start. Close other apps using the camera, or use a USB scanner.');}
    camera=starting;cameraButton();
  }));
  $('#manualScan').onsubmit=ev=>{ev.preventDefault();const input=$('#manualCode');submit(input.value.trim());input.value='';input.focus();};
  await update();
  scannerTimer=setInterval(update,15000);
}
function showResult(color,title,detail){const box=$('#scanResult');if(!box)return;box.className=`scan-result ${color}`;box.innerHTML=`<strong>${e(title)}</strong><small>${e(detail)}</small>`;}
function beep(green){try{const context=new(window.AudioContext||window.webkitAudioContext)();const osc=context.createOscillator(),gain=context.createGain();osc.connect(gain);gain.connect(context.destination);osc.frequency.value=green?900:220;gain.gain.value=.1;osc.start();osc.stop(context.currentTime+.15);osc.onended=()=>context.close();}catch{}}
(async()=>{try{role=(await api('/session')).role;await route();}catch{login();}})();
