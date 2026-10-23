'use strict';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, x => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[x]));
const e = escapeHtml;
let role, currentView = '', camera = null, service = null, scannerTimer = null, scannerVisibility = null, scannerBusy = false, printSettings = null;
const TIME_ZONE = 'Asia/Baghdad';
const dates = v => v ? new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short',timeZone:TIME_ZONE}).format(new Date(v)) : '—';
const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE}).format(new Date());
const longToday = () => new Intl.DateTimeFormat('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:TIME_ZONE}).format(new Date());
const number = n => new Intl.NumberFormat('en-GB').format(Number(n) || 0);
async function api(path, body) {
  const response = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type':'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== '/login' && location.pathname !== '/scanner') login(); throw Object.assign(new Error(result.error || 'Request failed.'), { status: response.status }); }
  return result;
}
function notify(message) { $('#notice').textContent = message; $('#notice').classList.add('visible'); clearTimeout(notify.timer); notify.timer = setTimeout(()=>$('#notice').classList.remove('visible'),7000); }
async function guard(fn) { try { await fn(); } catch (err) { notify(err.message); } }
async function busy(button, fn) { if (button.disabled) return; button.disabled = true; try { await fn(); } finally { button.disabled = false; } }
const LOGO = '/brand/faiz-e-husaini-logo-white.webp';
const brand = `<div class="brand"><img src="${LOGO}" alt="Faiz-e-Husaini Society (Iraq)" width="132" height="141"><strong>Mawaid</strong><span>Faiz-e-Husaini · Karbala</span></div>`;
const ornament = `<svg class="ornament" viewBox="0 0 200 18" aria-hidden="true"><path d="M0 9h82M118 9h82" stroke="currentColor" stroke-width="1" opacity=".55"/><g fill="none" stroke="currentColor" stroke-width="1.3"><rect x="94" y="3" width="12" height="12"/><rect x="94" y="3" width="12" height="12" transform="rotate(45 100 9)"/></g></svg>`;
async function stopScanner() { clearInterval(scannerTimer); scannerTimer = null; clearTimeout(retryTimer); if(scannerVisibility)document.removeEventListener('visibilitychange',scannerVisibility);scannerVisibility=null; if (camera) { try { await camera.stop(); } catch {} camera = null; } }
function login() {
  // Only the administrator signs in; the scanner at /scanner opens without a password.
  stopScanner(); role = null;
  $('#app').innerHTML = `<div class="login">${brand}<section class="panel"><h1>Mawaid printing system</h1><p>Sign in as Administrator to manage tours and print meal cards.</p><form id="loginForm"><label>Administrator password<input name="password" type="password" autocomplete="current-password" required autofocus></label><div class="error" id="loginError" role="alert"></div><button class="primary">Sign in</button></form><small>Cards are checked against each stay’s dates, in Karbala time.</small></section></div>`;
  $('#loginForm').onsubmit = async event => { event.preventDefault(); const f = new FormData(event.target); await busy($('button',event.target),async()=>{try { const data = await api('/login',Object.fromEntries(f)); role=data.role; await route(); } catch(err) { $('#loginError').textContent=err.message; } }); };
}
const navs = [['tours','▦','Tours'],['generate','＋','Add tour'],['prints','▤','Print log'],['logs','⌁','Scan log'],['summary','◫','Daily summary'],['settings','⚙','Settings']];
async function shell(view) {
  await stopScanner(); currentView=view;
  if($('#peopleDialog').open)$('#peopleDialog').close();
  $('#app').innerHTML=`<div class="shell"><aside class="sidebar">${brand}${ornament}<nav class="nav" aria-label="Main">${navs.map(([key,icon,label])=>`<a href="#${key}" class="${key===view?'active':''}" ${key===view?'aria-current="page"':''}><span class="icon" aria-hidden="true">${icon}</span>${label}</a>`).join('')}</nav><div class="foot"><a class="scanner-link" href="/scanner" target="_blank" rel="noopener">Open meal scanner</a><small>Three meals. One card.</small></div></aside><div><header class="topbar"><span class="title">Mawaid printing system</span><span class="when"><span><b>${e(longToday())}</b> · Karbala</span><button id="topLogout">Sign out</button></span></header><main id="main"></main></div></div>`;
  $('#topLogout').onclick=logout;
}
async function logout(){ await guard(async()=>{await api('/logout',{});login();}); }
const heading=(title,desc,action='')=>`<div class="heading"><div><h1>${title}</h1><p>${desc}</p></div>${action}</div>`;
async function route(){
  if(location.pathname==='/scanner')return scannerView();
  if(!role)return;
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
  $('#main').innerHTML=heading('Tours','Find an arrival date, select your tours, and print their meal cards.',`<button class="primary" id="newTour">＋ Add tour</button>`)+`<section class="panel"><form class="filters" id="tourFilters"><label>Arrival date<input type="date" name="arrival" value="${today()}"></label><label>Tour ID, ITS or office<input name="q" placeholder="Search tours…"></label><label>Show<select name="status"><option value="">All tours</option><option value="unprinted">Not printed</option><option value="printed">Printed</option></select></label><label>Sort by<select name="sort"><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="tour">Tour ID</option></select></label><button>Apply</button><button type="reset">Reset</button></form></section><section class="panel"><div class="tablebar"><span id="tourCount" class="count">Loading…</span><button class="primary" id="printSelected" disabled>Print selected</button></div><div class="tablewrap" id="tourTable"></div></section>`;
  $('#newTour').onclick=()=>location.hash='generate';
  // Only the latest load draws the list, so a slow earlier response cannot replace a newer filter's rows.
  let safaris=[],tours=[],loads=0;
  // Rows already printed are tinted light red: a tour once every person has a card, a Safari card once a sticker job holds it.
  const tourRow=t=>`<tr class="${t.issued>=t.pax?'printed-row':''}"><td><input class="tour-check" type="checkbox" value="${e(t.id)}" aria-label="Select tour ${e(t.tour_id||t.office)}" ${t.issued>=t.pax?'disabled':''}></td><td><strong>${e(t.tour_id||'—')}</strong></td><td>${e(t.its||'—')}</td><td>${e(t.office)}</td><td>${e(t.arrival)}</td><td>${e(t.departure)}${extensionChips(t.extensions)}</td><td>${e(t.pax)} <small>· ${e(t.issued)} issued</small></td><td>${printLogCell(t)}</td><td class="nowrap"><button class="replace" data-tour="${e(t.id)}" ${!t.issued?'disabled':''}>Replace cards</button> <button class="extend" data-tour="${e(t.id)}">Extend</button></td></tr>`;
  // A Safari card always prints as its QR-free sticker and can be printed again at any time.
  const safariRow=s=>`<tr class="${s.batch_id?'printed-row':''}"><td><input class="safari-check" type="checkbox" value="${e(s.id)}" aria-label="Select Safari ${e(s.office||s.tour_id||'card')}"></td><td>${s.tour_id?`<strong>${e(s.tour_id)}</strong> `:''}<span class="chip safari-chip">Safari</span></td><td>${e(s.its||'—')}</td><td>${e(s.office||'—')}</td><td>${e(s.arrival||'—')}</td><td>${e(s.departure||'—')}</td><td>${e(s.pax??'—')}</td><td>${printLogCell(s)}</td><td><button class="print-safari" data-safari="${e(s.id)}">Print sticker</button></td></tr>`;
  const load=async()=>{const params=new URLSearchParams(new FormData($('#tourFilters'))),n=++loads;const [listed,found]=await Promise.all([api(`/tours?${params}`),api(`/safaris?${params}`)]);if(n!==loads)return;safaris=found;tours=listed;
    // Stable sort in the chosen order: Safari cards follow the tours that tie with them; undated or unnumbered cards come last.
    const sort=params.get('sort'),key=sort==='tour'?'tour_id':'arrival',flip=sort==='oldest'||sort==='tour'?1:-1;
    const rows=[...tours,...safaris.map(s=>({...s,safari:true}))].sort((a,b)=>!a[key]-!b[key]||flip*String(a[key]||'').localeCompare(String(b[key]||''),'en',{numeric:true}));
    $('#tourCount').textContent=`${number(tours.length)} tour${tours.length===1?'':'s'}${safaris.length?` · ${number(safaris.length)} Safari`:''}`;
    $('#tourTable').innerHTML=rows.length?`<table><thead><tr><th><input type="checkbox" id="allTours" aria-label="Select all unprinted tours"></th><th>Tour ID</th><th>ITS</th><th>Office</th><th>Arrival</th><th>Departure</th><th>PAX</th><th>Print log</th><th>Actions</th></tr></thead><tbody>${rows.map(r=>r.safari?safariRow(r):tourRow(r)).join('')}</tbody></table>`:params.get('arrival')||params.get('q')||params.get('status')?`<div class="empty"><h2>No tours match</h2><p>Change the filters, or clear the arrival date to see every tour.</p></div>`:`<div class="empty"><h2>No tours to show</h2><p>Add a tour, or connect your Google Sheet in Settings.</p></div>`;
    const update=()=>{$('#printSelected').disabled=!$$('.tour-check:checked, .safari-check:checked').length;};
    if($('#allTours'))$('#allTours').onchange=event=>{$$('.tour-check:not(:disabled)').forEach(c=>c.checked=event.target.checked);update();};
    $$('.tour-check, .safari-check').forEach(c=>c.onchange=update);$$('.replace').forEach(b=>b.onclick=()=>guard(()=>replaceCards(b.dataset.tour)));
    $$('.extend').forEach(b=>b.onclick=()=>guard(()=>extendTour(tours.find(t=>t.id===b.dataset.tour),()=>guard(load))));
    $$('.print-safari').forEach(b=>b.onclick=()=>guard(()=>busy(b,()=>printSafaris(safaris.filter(s=>s.id===b.dataset.safari)))));update();
  };
  $('#tourFilters').onsubmit=ev=>{ev.preventDefault();guard(load);};$$('#tourFilters select').forEach(s=>s.onchange=()=>guard(load));$('#tourFilters').onreset=()=>setTimeout(()=>guard(load),0);
  $('#printSelected').onclick=()=>guard(async()=>{await busy($('#printSelected'),async()=>{
    const tourIds=$$('.tour-check:checked').map(c=>c.value),picked=$$('.safari-check:checked').map(c=>c.value);
    if(picked.length)await printSafaris(safaris.filter(s=>picked.includes(s.id)));
    if(tourIds.length)await createLabels({tourIds});
  });await load();});
  await load();
}
async function generateView(){
  $('#main').innerHTML=heading('Add tour','Create meal cards for people who are not in the Google Sheet.')+`<section class="panel"><form class="form" id="addTour"><div class="grid"><label><span>Tour ID <small>(optional)</small></span><input name="tour_id" maxlength="80" placeholder="e.g. 26/3205"></label><label><span>ITS <small>(optional)</small></span><input name="its" maxlength="40" inputmode="numeric" placeholder="ITS number"></label><label>Office name<input name="office" maxlength="160" required placeholder="Tour office"></label><label>Number of people (PAX)<input name="pax" type="number" min="1" max="10000" step="1" required></label><label>Arrival date<input name="arrival" type="date" required></label><label>Departure date<input name="departure" type="date" required></label></div><div class="helper">Each person gets one QR card for breakfast, lunch and dinner throughout their stay. If this tour already exists for the same arrival date, use <strong>Replace cards</strong> for lost cards; meal limits stay the same.</div><div class="actions"><button type="submit" name="action" value="save">Submit</button><button type="submit" class="primary" name="action" value="print">Submit &amp; print</button></div></form></section><section class="panel"><h2>Safari</h2><p>Takeaway lunch and dinner. One sticker covers the whole stay and has no QR code. Every field is optional; a blank date or PAX prints as a line to write on.</p><form class="form" id="addSafari"><div class="grid"><label>Office or tour name<input name="office" maxlength="160" placeholder="Tour office"></label><label>Packs (PAX)<input name="pax" type="number" min="1" max="10000" step="1"></label><label>Arrival date<input name="arrival" type="date"></label><label>Departure date<input name="departure" type="date"></label><label>Tour ID<input name="tour_id" maxlength="80"></label><label>ITS<input name="its" maxlength="40" inputmode="numeric"></label></div><div class="helper">Safari cards always print as the Lunch/Dinner sticker without a QR code, here and from the Tours page. Each sticker is headed Izan Card. The office name, tour ID and ITS help you find the card later; they are not printed.</div><div class="actions"><button type="submit" name="action" value="save">Submit</button><button type="submit" class="primary" name="action" value="print">Submit &amp; print</button></div></form></section>`;
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
/* Extend stay: extra meals after departure on the same QR cards, a whole day or lunch only. */
const shortDay=d=>new Intl.DateTimeFormat('en-GB',{weekday:'short',day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(d));
const addDays=(d,n)=>new Date(Date.parse(d)+n*86400000).toISOString().slice(0,10);
const extensionLabel={day:'Whole day',lunch:'Lunch only'};
function extensionChips(list){
  return String(list||'').split(',').filter(Boolean).sort().map(x=>{const [date,meals]=x.split(' ');return `<span class="ext-chip" title="Stay extended">+ ${e(shortDay(date))} · ${e(meals==='lunch'?'Lunch':'All day')}</span>`;}).join('');
}
async function extendTour(tour,changed){
  const history=await api(`/tours/${tour.id}/extensions`),first=addDays(tour.departure,1),pick=first>today()?first:today();
  const name=tour.tour_id?`Tour ${tour.tour_id}`:tour.office;
  $('#peopleContent').innerHTML=`<h2>Extend stay</h2><p><b>${e(name)}</b> · ${e(tour.office)} · ${e(tour.pax)} PAX. Meals are included until <b>${e(shortDay(tour.departure))}</b>. Their QR cards keep working: nothing new to print.</p><label class="extend-day">Day to add<input type="date" id="extendDate" value="${pick}" min="${first>today()?first:today()}" max="${addDays(tour.departure,30)}"></label><div class="extend-choices"><button type="button" class="primary" data-meals="lunch"><b>Lunch only</b><small>11:00 am–7:30 pm</small></button><button type="button" class="primary" data-meals="day"><b>Whole day</b><small>Breakfast, lunch and dinner</small></button></div>${history.length?`<h3>Extensions</h3><ul class="extension-list">${history.map(x=>`<li class="${x.removed_at?'removed':''}"><span><b>${e(shortDay(x.date))} · ${e(extensionLabel[x.meals])}</b><br><small>${x.removed_at?`Removed ${e(dates(x.removed_at))}`:`Added ${e(dates(x.created_at))}`}</small></span>${x.removed_at?'':`<button type="button" class="danger remove-extension" data-id="${e(x.id)}">Remove</button>`}</li>`).join('')}</ul>`:''}`;
  if(!$('#peopleDialog').open)$('#peopleDialog').showModal();
  $$('.extend-choices button').forEach(b=>b.onclick=()=>guard(()=>busy(b,async()=>{
    const date=$('#extendDate').value;if(!date)throw new Error('Choose the day to add.');
    await api(`/tours/${tour.id}/extensions`,{date,meals:b.dataset.meals});
    notify(`${name} extended: ${b.dataset.meals==='lunch'?'lunch':'breakfast, lunch and dinner'} on ${shortDay(date)}. Their current QR cards will work.`);
    changed();await extendTour(tour,changed);
  })));
  $$('.remove-extension').forEach(b=>b.onclick=()=>guard(()=>busy(b,async()=>{await api(`/extensions/${b.dataset.id}/remove`,{});notify('Extension removed.');changed();await extendTour(tour,changed);})));
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
const scriptPromises={};
function loadScript(src,error){
  if(!scriptPromises[src])scriptPromises[src]=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=()=>{delete scriptPromises[src];script.remove();reject(new Error(error));};document.head.appendChild(script);});
  return scriptPromises[src];
}
const loadPdfLibrary=()=>loadScript('/vendor/pdf.js','The PDF library could not load. Please try again.');
const loadZebra=()=>loadScript('/vendor/zebra.js','The Zebra printing library could not load. Reload the page.');
async function finishPdf(batch){
  if(!batch.requiresPdfUpload)return;
  if(!batch.cards)batch=await api(`/batches/${batch.id}/manifest`);
  await loadPdfLibrary();
  notify('Generating labels on this computer…');
  const pdf=await window.generateMawaidPdf(batch.cards,batch.printer);
  const response=await fetch(`/api/batches/${batch.id}/pdf`,{method:'POST',headers:{'Content-Type':'application/pdf'},body:pdf});
  if(!response.ok){const result=await response.json();throw new Error(result.error||'The PDF could not be saved. Use Finish PDF in Print log.');}
}
// The browser reaches the USB printer through the QZ Tray app on this computer; its errors are explained in plain words.
const VIEW_PDF_TIP='You can also open View PDF in Print log and print it from the browser at 100% scale (Actual size).';
// Direct (ZPL) sends each sticker as one Zebra label with gap-label settings; Driver hands the PDF to the computer's printer driver.
// The choice belongs to the printing computer, so it is kept in this browser.
const PRINT_METHOD_KEY='mawaidPrintMethod';
function printMethod(){try{return localStorage.getItem(PRINT_METHOD_KEY)==='driver'?'driver':'zpl';}catch{return 'zpl';}}
// Darkness for direct printing, 1 (lighter) to 5 (darker); 3 is the middle.
const PRINT_TONE_KEY='mawaidPrintTone';
function printTone(){try{const t=Number(localStorage.getItem(PRINT_TONE_KEY));return t>=1&&t<=5?t:3;}catch{return 3;}}
async function connectPrinter(settings){
  if(!window.qz)throw new Error(`The printer library did not load. Reload the page. ${VIEW_PDF_TIP}`);
  if(!qz.websocket.isActive()){try{await qz.websocket.connect();}catch{throw new Error(`QZ Tray is not running on this computer, so the printer can’t be reached. Open the QZ Tray app (install it from qz.io if it is missing), then use Print PDF in Print log. ${VIEW_PDF_TIP}`);}}
  try{return await qz.printers.find(settings.name);}catch{throw new Error(`QZ Tray can’t find a printer named “${settings.name}”. Check the printer name in Settings. ${VIEW_PDF_TIP}`);}
}
async function sendZpl(printerName,zpl,jobName){
  try{await qz.print(qz.configs.create(printerName,{jobName}),[{type:'raw',format:'command',flavor:'plain',data:zpl}]);}catch(err){throw new Error(`The printer reported a problem (${err?.message||err}). Check that it is on, has labels and is connected, then use Print PDF in Print log.`);}
}
async function sendToPrinter(bytes,settings,jobName){
  const printerName=await connectPrinter(settings);
  if(printMethod()==='zpl'){
    await loadZebra();
    return sendZpl(printerName,await window.mawaidZebra.pdfToZpl(bytes,{...settings,tone:printTone()}),jobName);
  }
  let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
  const config=qz.configs.create(printerName,{size:{width:settings.widthMm,height:settings.heightMm},units:'mm',colorType:'blackwhite',scaleContent:false,margins:0,jobName});
  try{await qz.print(config,[{type:'pixel',format:'pdf',flavor:'base64',data:btoa(binary)}]);}catch(err){throw new Error(`The printer reported a problem (${err?.message||err}). Check that it is on, has labels and is connected, then use Print PDF in Print log.`);}
}
// Printer tools in Settings: a test sticker, label calibration and stopping a run of stickers.
async function printerTool(tool){
  const settings=(await api('/settings')).printer,printerName=await connectPrinter(settings);await loadZebra();const z=window.mawaidZebra;
  if(tool==='test'){await sendZpl(printerName,z.testZpl({...settings,tone:printTone()}),'Mawaid test sticker');return 'Test sticker sent. One sticker should come out with a frame just inside its edges.';}
  if(tool==='calibrate'){await sendZpl(printerName,z.saveMediaZpl({...settings,tone:printTone()}),'Mawaid label settings');await new Promise(r=>setTimeout(r,1500));await sendZpl(printerName,z.CALIBRATE_ZPL,'Mawaid calibrate');return 'Calibrating: the printer feeds a few blank labels, then stops with a solid green light. Then print a test sticker.';}
  await sendZpl(printerName,z.CANCEL_ZPL,'Mawaid stop');return 'Stop sent: the printer drops every label still in its memory.';
}
async function printBatch(id,jobName='Mawaid meal cards'){
  try {
    printSettings=(await api('/settings')).printer;
    const response=await fetch(`/api/batches/${id}/pdf`);if(!response.ok)throw new Error('Could not fetch the saved label PDF.');
    await sendToPrinter(new Uint8Array(await response.arrayBuffer()),printSettings,jobName);
    await api(`/batches/${id}/status`,{status:'sent_to_printer'});notify('Job sent to the Zebra printer. Check the physical labels.');return true;
  } catch(err) {
    await api(`/batches/${id}/status`,{status:'printer_error'}).catch(()=>{});
    notify(`PDF saved in Print log. ${err.message}`);return false;
  }
}
// Safari stickers have no QR code: this computer draws them, saves the PDF in Print log, then prints it like any label job.
let pendingSafariJob=null;
async function printSafaris(safaris){
  if(!safaris.length)return;
  if(safaris.length>100)throw new Error('Print up to 100 Safari stickers at a time.');
  const ids=safaris.map(s=>s.id).join(',');
  // A retry after a failed save reuses the request key, so it never saves the same job twice.
  if(!pendingSafariJob||pendingSafariJob.ids!==ids)pendingSafariJob={ids,key:crypto.randomUUID()};
  notify('Preparing Safari stickers…');
  await loadPdfLibrary();
  const settings=(await api('/settings')).printer,pdf=await window.generateSafariPdf(safaris,settings);
  const response=await fetch(`/api/safaris/print?${new URLSearchParams({requestKey:pendingSafariJob.key,ids})}`,{method:'POST',headers:{'Content-Type':'application/pdf'},body:pdf});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'The Safari PDF could not be saved. Please try again.');
  pendingSafariJob=null;
  notify('PDF saved in Print log. Sending to the printer…');
  await printBatch(result.id,'Mawaid Safari stickers');
}
const printKind = kind => ({ replacement:'Replacement', safari:'Safari stickers' }[kind]||'New cards');
const printStatus = { generated:'PDF saved', awaiting_pdf:'Waiting for PDF', sent_to_printer:'Sent to printer', printer_error:'Printer error', pdf_cleared:'PDF cleared' };
async function printsView(){
  const batches=await api('/batches');
  $('#main').innerHTML=heading('Print log','Every label PDF is saved here, including Safari stickers. Printing a PDF again uses the same QR codes.')+`<section class="panel tablewrap">${batches.length?`<table><thead><tr><th>Created · Karbala</th><th>Type</th><th>Labels</th><th>Status</th><th>Saved PDF</th><th>Action</th></tr></thead><tbody>${batches.map(b=>{const cleared=b.printer_status==='pdf_cleared',pending=b.pdf_ready===0&&!cleared;return `<tr><td>${e(dates(b.created_at))}</td><td>${printKind(b.kind)}</td><td>${e(b.count)} <small>· ${e(b.active_count)} active</small></td><td><span class="chip ${b.printer_status==='printer_error'?'red-chip':b.printer_status==='sent_to_printer'?'green-chip':''}">${e(printStatus[b.printer_status]||b.printer_status.replaceAll('_',' '))}</span></td><td>${cleared?'<span class="muted">Cleared after the stay</span>':pending?'<span class="chip">PDF pending</span>':`<a href="/api/batches/${e(b.id)}/pdf" target="_blank" rel="noopener">View PDF</a>`}</td><td><button class="retry-print" data-pending="${pending}" data-id="${e(b.id)}" ${!b.active_count||cleared?'disabled':''}>${pending?'Finish PDF':'Print PDF'}</button></td></tr>`;}).join('')}</tbody></table>`:'<div class="empty"><h2>No label PDFs yet</h2><p>Select tours on the Tours page and choose Print selected.</p></div>'}</section><p>Older PDFs can include replaced QR codes; printing them again does not reactivate those codes. “Sent to printer” means QZ Tray accepted the job; check that the labels came out.</p>`;
  $$('.retry-print').forEach(b=>b.onclick=()=>guard(()=>busy(b,async()=>{if(b.dataset.pending==='true'){await finishPdf(await api(`/batches/${b.dataset.id}/manifest`));await printsView();}else await printBatch(b.dataset.id);})));
}
async function logsView(){
  $('#main').innerHTML=heading('Scan log','Every admission and declined scan, from every scanner.')+`<section class="panel"><form class="filters" id="logFilters"><label>Date<input type="date" name="date" value="${today()}"></label><label>Tour ID<input name="tour"></label><label>Office<input name="office"></label><label>Result<select name="status"><option value="">All</option><option value="green">Green · admitted</option><option value="red">Red · declined</option></select></label><button>Apply</button><button type="reset">Reset</button></form></section><section class="panel tablewrap" id="logTable"></section>`;
  const load=async()=>{const rows=await api(`/logs?${new URLSearchParams(new FormData($('#logFilters')))}`);$('#logTable').innerHTML=rows.length?`<table><thead><tr><th>Time · Karbala</th><th>Tour ID</th><th>Office</th><th>Person</th><th>Meal</th><th>Result</th><th>Reason</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${e(dates(r.scanned_at))}</td><td>${e(r.display_tour||'—')}</td><td>${e(r.office||'—')}</td><td>${e(r.person_no||'—')}</td><td>${e(r.meal||'—')}</td><td><span class="chip ${r.reason==='admitted'?'green-chip':'red-chip'}">${r.reason==='admitted'?'Green':'Red'}</span>${r.offline?' <span class="chip" title="Checked on a phone without a connection, sent later">Offline</span>':''}</td><td>${e(r.reason.replaceAll('_',' '))}</td></tr>`).join('')}</tbody></table><p class="status-note">Showing the latest ${number(1000)} matching scans.</p>`:'<div class="empty"><h2>No scans match</h2><p>Try another date or clear the filters.</p></div>';};
  $('#logFilters').onsubmit=ev=>{ev.preventDefault();guard(load);};$('#logFilters').onreset=()=>setTimeout(()=>guard(load),0);await load();
}
async function summaryView(){
  $('#main').innerHTML=heading('Daily scan summary','Successful meal admissions for the selected Karbala date. Duplicate and declined scans are excluded.')+`<section class="panel"><form class="filters" id="summaryFilters"><label>Date<input type="date" name="date" value="${today()}"></label><button>Refresh</button></form></section><div id="summaryContent"></div><section class="panel" id="tourReport"></section>`;
  const meals=[['breakfast','Breakfast','Until 11:00 am'],['lunch','Lunch','11:00 am–7:30 pm'],['dinner','Dinner','From 7:30 pm']];
  const load=async()=>{
    const query=new URLSearchParams(new FormData($('#summaryFilters'))),[counts,report]=await Promise.all([api(`/summary?${query}`),api(`/summary/tours?${query}`)]);
    $('#summaryContent').innerHTML=`<div class="metric-row">${[...meals,['scans','Daily scans','Successful admissions']].map(([key,label,hours])=>`<div class="metric"><span>${label}</span><strong data-count="${key}">${number(counts[key])}</strong><small>${hours}</small></div>`).join('')}</div>${counts.other?`<p class="status-note">${number(counts.other)} historical scans have no meal assigned and are included in the daily total.</p>`:''}`;
    // Tour-wise: meals served against PAX for every tour staying, extended or served on this date.
    const cell=(t,key)=>t.extension==='lunch'&&key!=='lunch'?'<td class="meal">—</td>':`<td class="meal ${t[key]>=t.pax?'full':''}"><b>${number(t[key])}</b> <small>of ${number(t.pax)} scanned</small></td>`;
    const total=key=>report.reduce((n,t)=>n+(Number(t[key])||0),0);
    $('#tourReport').innerHTML=`<h2>By tour</h2><p>Meals scanned for each tour against its PAX, for tours staying, extended or served on this date.</p>${report.length?`<div class="tablewrap"><table class="report"><thead><tr><th>Tour ID</th><th>Office</th><th>PAX</th>${meals.map(([,label])=>`<th>${label}</th>`).join('')}</tr></thead><tbody>${report.map(t=>`<tr><td><strong>${e(t.tour_id||'—')}</strong>${t.extension?`<span class="ext-chip">Extended · ${e(extensionLabel[t.extension])}</span>`:''}</td><td>${e(t.office)}</td><td>${e(t.pax)}</td>${meals.map(([key])=>cell(t,key)).join('')}</tr>`).join('')}</tbody><tfoot><tr><td colspan="2">${number(report.length)} tour${report.length===1?'':'s'}</td><td>${number(total('pax'))}</td>${meals.map(([key])=>`<td>${number(total(key))}</td>`).join('')}</tr></tfoot></table></div>`:'<div class="empty"><p>No tours were staying on this date.</p></div>'}`;
  };
  $('#summaryFilters').onsubmit=ev=>{ev.preventDefault();guard(load);};await load();
}

const megabytes = bytes => `${(bytes/1e6).toFixed(1)} MB`;
async function settingsView(){
  const settings=await api('/settings'),p=settings.printer,s=settings.source;window.mawaidBatchLimit=settings.maxLabels||500;
  const free=settings.hosting==='cloudflare-free',limit=settings.databaseLimitBytes||500e6,used=settings.databaseBytes||0,share=Math.min(100,used/limit*100);
  $('#main').innerHTML=heading('Settings','Storage, your Google Sheet and the Zebra ZD220D printer.')+`<section class="panel" id="storagePanel"><h2>${free?'Free hosting storage':'Database storage'}</h2>${free?`<div class="storage-figures"><span><b>${megabytes(used)}</b> used</span><span>${megabytes(limit)} limit</span></div><div class="meter ${share>=90?'full':share>=70?'high':''}" role="meter" aria-label="Database storage used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${share.toFixed(0)}"><i style="width:${share.toFixed(1)}%"></i></div>`:`<div class="storage-figures"><span><b>${megabytes(used)}</b> used</span></div>`}<p>Scan history and saved label PDFs use this space. Archive older records to this computer, then clear them here. Nothing is ever deleted automatically.</p><form class="clear-form" id="clearForm"><label>Clear records from before<input type="date" name="before" value="${today()}" max="${today()}" required></label><ul class="ready-list" id="readyList" aria-live="polite"><li>Counting records…</li></ul><p class="status-note">Today’s meals and anyone still staying are never affected. Each archive is a folder of spreadsheets (CSV): scans, meals served, a daily meal summary, tours, cards, print jobs and stay extensions. Label PDFs are not included.</p><div class="actions"><button type="submit" class="primary" id="archiveClear">Archive &amp; clear</button><button type="button" class="danger" id="deleteRecords" disabled>Delete without archiving</button></div><div class="folder-line" id="folderLine"></div><p class="archive-progress" id="archiveProgress" role="status"></p><p class="status-note" id="allowanceNote"></p></form></section><section class="panel"><h2>Google Sheet</h2><p>Pehli Ziyarat is the arrival date. Departure is the day after Wada Ziyarat. The separate ToursSync Apps Script sends updates to this app; the existing flatten function and trigger stay in place.</p><form class="form" id="sourceSettings"><label>Google Sheet URL<input name="url" value="https://docs.google.com/spreadsheets/d/${e(s.spreadsheetId)}/edit" required></label><div class="grid"><label>Source tab<input name="tab" list="sourceTabs" value="${e(s.tab)}" required><datalist id="sourceTabs">${(settings.sync?.tabs||[]).map(t=>`<option value="${e(t)}">`).join('')}</datalist></label><div><small>Tab names appear after the first successful sync.</small></div></div><label>Daily sync times in Karbala (optional)<input name="dailyTimes" value="${e((s.dailyTimes||[]).join(', '))}" placeholder="Leave blank for every 5 minutes, or 06:00, 12:00, 18:00"></label><div class="actions"><button>Save sheet connection</button><button type="button" id="requestSync">Request sync</button></div></form><p class="status-note">${settings.sync?`Last successful sync: ${e(dates(settings.sync.lastSuccess))} · ${e(settings.sync.imported)} stays`:'No sync received yet. Install apps-script/ToursSync.js and run its setup function.'}</p>${(settings.sync?.warnings||[]).map(w=>`<p class="warning-note">${e(w)}</p>`).join('')}</section><section class="panel"><h2>Zebra ZD220D</h2><p>Install QZ Tray and the Zebra driver on the USB-connected printing computer, and open this app on that computer. Your stickers are 3 inches wide × 2 inches high (76.2 × 50.8 mm).</p><form class="form" id="printerSettings"><label>Printer name (as shown by the computer)<input name="name" value="${e(p.name)}" required></label><div class="grid"><label>Label width (mm)<input type="number" name="widthMm" min="40" max="104" step="0.1" value="${e(p.widthMm)}" required></label><label>Label height (mm)<input type="number" name="heightMm" min="50.8" max="200" step="0.1" value="${e(p.heightMm)}" required></label></div><small>${p.confirmed?'Label size confirmed.':'Save the printer settings to confirm this label size.'} Labels below 80 mm high need a width of at least 70 mm.</small><div class="actions"><button>Confirm &amp; save printer settings</button></div></form><h3 class="print-method-title">Printing on this computer</h3><div class="print-method" role="radiogroup" aria-label="Printing method"><label><input type="radio" name="printMethod" value="zpl" ${printMethod()==='zpl'?'checked':''}><span><b>Direct to Zebra</b> (recommended): one sticker per label, set by the app</span></label><label><input type="radio" name="printMethod" value="driver" ${printMethod()==='driver'?'checked':''}><span><b>Through the printer driver</b>: uses the driver’s paper settings</span></label></div><label class="tone-field">Print darkness (direct to Zebra)<select id="printTone">${[[1,'1 · Lightest'],[2,'2 · Lighter'],[3,'3 · Middle (recommended)'],[4,'4 · Darker'],[5,'5 · Darkest']].map(([v,t])=>`<option value="${v}" ${printTone()===v?'selected':''}>${t}</option>`).join('')}</select></label><div class="actions"><button type="button" class="printer-tool" data-tool="test">Print test sticker</button><button type="button" class="printer-tool" data-tool="calibrate">Calibrate labels</button><button type="button" class="printer-tool danger" data-tool="stop">Stop printing</button></div><p class="status-note">Text too bold or smudged: choose a lighter darkness; too faint: a darker one. If stickers come out blank or keep feeding: press <b>Stop printing</b>, then <b>Calibrate labels</b>, then <b>Print test sticker</b>. Calibrate feeds a few blank labels; that is normal.</p><p class="status-note">The ZD220D prints in black only, so meal cards use solid black throughout. QZ Tray may ask you to approve this site; fully silent printing needs a trusted QZ certificate.</p></section><section class="panel"><h2>Meal scanner</h2><p>One admission per person per meal, using Karbala time: <b>breakfast</b> until 11:00 am, <b>lunch</b> from 11:00 am until 7:30 pm, <b>dinner</b> from 7:30 pm. A scan at any time counts for that meal. <b>Green</b>: a current card within its stay dates (or a day added with <b>Extend</b> on the Tours page), not already used for that meal. <b>Red</b>: a duplicate admission, unknown or replaced card, a date outside the stay, a tour no longer in the Google Sheet, or a person above the tour’s PAX. Safari stickers have no QR code and are not scanned.</p><p>If the Wi-Fi drops, the scanner keeps checking cards against the list held on the phone, shows <b>Offline</b>, and sends those scans when the connection returns. Two offline phones cannot see each other’s scans.</p><a href="/scanner" target="_blank" rel="noopener">Open the meal scanner</a></section>`;
  $('#sourceSettings').onsubmit=ev=>{ev.preventDefault();guard(async()=>{const f=new FormData(ev.target),id=String(f.get('url')).match(/\/spreadsheets\/d\/([\w-]+)/)?.[1];if(!id)throw new Error('Enter a Google Sheets URL.');await api('/settings',{source:{spreadsheetId:id,tab:f.get('tab'),dailyTimes:String(f.get('dailyTimes')||'').split(',').map(t=>t.trim()).filter(Boolean)}});notify('Sheet connection saved. Use the same tab in the separate Apps Script.');});};
  $('#requestSync').onclick=()=>guard(async()=>{await api('/sync/request',{});notify('Sync requested. The separate Apps Script will send it on its next five-minute run.');});
  $$('input[name=printMethod]').forEach(r=>r.onchange=()=>{try{localStorage.setItem(PRINT_METHOD_KEY,r.value);}catch{}notify(r.value==='zpl'?'This computer now prints directly to the Zebra.':'This computer now prints through the printer driver.');});
  $('#printTone').onchange=ev=>{try{localStorage.setItem(PRINT_TONE_KEY,ev.target.value);}catch{}notify('Darkness saved on this computer. Print a test sticker to check it.');};
  $$('.printer-tool').forEach(b=>b.onclick=()=>guard(()=>busy(b,async()=>notify(await printerTool(b.dataset.tool)))));
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
  for(const [key,label] of [['scans','scan records'],['meals','meals served'],['tours','tours'],['cards','cards'],['prints','print jobs'],['extensions','stay extensions']]){
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
    ['scan-log.csv',csv(['Time (Karbala)','Service date','Meal','Tour ID','Office','Person','Result','Reason','Checked offline'],d.scans.map(r=>[karbalaTime(r.scanned_at),r.date,mealName(r.meal),r.tour_id,r.office,r.person_no,r.reason==='admitted'?'Admitted':'Declined',r.reason.replaceAll('_',' '),r.offline?'Yes':'']))],
    ['meals-served.csv',csv(['Service date','Meal','Tour ID','Office','Person','Scanned (Karbala)'],d.meals.map(r=>[r.date,mealName(r.meal),r.tour_id,r.office,r.person_no,karbalaTime(r.scanned_at)]))],
    ['daily-meal-summary.csv',csv(['Service date','Tour ID','Office','PAX','Breakfast','Lunch','Dinner'],summary.map(r=>[r.date,r.tour_id,r.office,r.pax,r.breakfast,r.lunch,r.dinner]))],
    ['tours.csv',csv(['Tour ID','ITS','Office','Arrival','Departure','PAX','Cards issued','Source','Active','Added (Karbala)'],d.tours.map(t=>[t.tour_id,t.its,t.office,t.arrival,t.departure,t.pax,t.issued,t.source==='sheets'?'Google Sheet':'Added manually',t.active?'Yes':'No',karbalaTime(t.created_at)]))],
    ['cards.csv',csv(['Tour ID','Office','Arrival','Person','Card printed (Karbala)','Replaced (Karbala)','Print job'],d.cards.map(c=>[c.tour_id,c.office,c.arrival,c.person_no,karbalaTime(c.created_at),karbalaTime(c.revoked_at),c.batch_id]))],
    ['extensions.csv',csv(['Tour ID','Office','Departure','Extended day','Meals','Added (Karbala)','Removed (Karbala)'],d.extensions.map(x=>[x.tour_id,x.office,x.departure,x.date,extensionLabel[x.meals],karbalaTime(x.created_at),karbalaTime(x.removed_at)]))],
    ['print-log.csv',csv(['Created (Karbala)','Type','Labels','Status','PDF','Print job'],d.prints.map(b=>[karbalaTime(b.created_at),printKind(b.kind),b.labels,printStatus[b.printer_status]||b.printer_status,b.printer_status==='pdf_cleared'?'Cleared':b.pdf_saved?'Saved in app':'Pending',b.batch_id]))],
    ['read-me.txt',`Mawaid archive · Faiz-e-Husaini Karbala\r\n${name} (Karbala time)\r\n\r\nScan records and meals served are from before ${before}. Tours, cards and print jobs are a full copy of what the app held at this time.\r\nLabel PDFs are not included. Times are Karbala time (Asia/Baghdad).\r\n\r\nscan-log.csv            ${d.scans.length} scans, admitted and declined\r\nmeals-served.csv        ${d.meals.length} meals served\r\ndaily-meal-summary.csv  meals served per tour per day\r\ntours.csv               ${d.tours.length} tours\r\ncards.csv               ${d.cards.length} cards, including replaced cards\r\nprint-log.csv           ${d.prints.length} print jobs\r\nextensions.csv          ${d.extensions.length} stay extensions, including removed ones\r\n`],
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
/* Gate phones check cards online first. When the Wi-Fi drops they keep checking against a copy of the current
   cards held on the phone, and send those scans to the server once the connection returns. */
const OFFLINE_DATA_KEY='mawaidScannerData',OFFLINE_QUEUE_KEY='mawaidScanQueue',ONLINE_TIMEOUT=3000;
let offlineData=null,scanQueue=[],connected=true,toursPolls=0,retryTimer=null;
const OFFLINE_REASONS={admitted:'Welcome — meal allowed',unknown_card:'Card not on this phone’s list',inactive_tour:'Tour is no longer active',replaced_card:'This card was replaced',before_arrival:'Arrival date has not started',after_departure:'Stay has ended',over_capacity:'Person exceeds the current tour PAX',outside_meal_time:'Meal service is closed',extension_other_meal:'Stay extended for lunch only today',already_scanned:'Already admitted for this meal today'};
function readStored(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}}
function store(key,value){try{localStorage.setItem(key,JSON.stringify(value));}catch{}}
const clock12=v=>new Intl.DateTimeFormat('en-GB',{hour:'numeric',minute:'2-digit',hour12:true,timeZone:TIME_ZONE}).format(new Date(v));
function karbalaService(now,meals){
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:TIME_ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));
  const minutes=+p.hour*60+ +p.minute,meal=(meals||[]).find(m=>minutes>=m.start&&minutes<m.end);
  return {date:`${p.year}-${p.month}-${p.day}`,meal:meal?.id||null,mealLabel:meal?.label||null};
}
// Merge one download into the phone's copy. A person's newer card replaces their older ones.
function applyOfflineData(data){
  if(!Array.isArray(data.cards))return;
  const d=data.full||!offlineData||offlineData.hash!==data.hash?{hash:data.hash,cards:{},tours:{},ext:{},served:{},servedDate:data.date}:offlineData;
  if(data.full)d.cards={};
  if(data.tours){d.tours={};for(const [id,arrival,departure,pax,active] of data.tours)d.tours[id]=[arrival,departure,pax,active];d.ext={};for(const [tour,date,meals] of data.extensions||[])d.ext[`${tour}|${date}`]=meals;}
  for(const [hash,person,tour,no,revoked] of data.cards){
    if(!data.full)for(const old of Object.values(d.cards))if(old[0]===person)old[3]=1;
    d.cards[hash]=[person,tour,no,revoked];
    if(!d.tours[tour])d.needTours=true;
  }
  if(d.servedDate!==data.date){d.served={};d.servedDate=data.date;}
  for(const [person,meal] of data.admissions||[])d.served[`${person}|${meal}`]??=1;
  Object.assign(d,{cardCursor:data.cardCursor,admissionCursor:data.admissionCursor,meals:data.meals,updatedAt:Date.now()});
  if(data.tours)d.needTours=false;
  offlineData=d;store(OFFLINE_DATA_KEY,d);
}
async function timedFetch(path,options={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),ONLINE_TIMEOUT);
  try{const response=await fetch(path,{...options,signal:controller.signal});if(response.status>=500)throw new Error('Server unavailable');return response;}
  finally{clearTimeout(timer);}
}
async function pollOfflineData(){
  const d=offlineData,params=new URLSearchParams();
  if(d?.cardCursor&&d.hash){params.set('cards',d.cardCursor);params.set('admissions',d.admissionCursor||0);params.set('date',d.servedDate||'');}
  if(!d?.cardCursor||d.needTours||++toursPolls%10===0)params.set('tours','1');
  const response=await timedFetch(`/api/scanner/data?${params}`),data=await response.json();
  if(!response.ok)throw new Error(data.error||'Request failed.');
  applyOfflineData(data);return data;
}
async function sha256(text,format){
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
  return format==='hex'?[...digest].map(b=>b.toString(16).padStart(2,'0')).join(''):btoa(String.fromCharCode(...digest));
}
// The same rules as the server, in the same order, against the phone's copy.
async function checkOffline(code,now){
  const d=offlineData,service=karbalaService(now,d?.meals),result={date:service.date,meal:service.meal,offline:true};
  const reason=await(async()=>{
    if(!code.startsWith('MW1:'))return 'unknown_card';
    const card=d.cards[await sha256(code.slice(4),d.hash)],tour=card&&d.tours[card[1]];
    if(!card||!tour)return 'unknown_card';
    const [person,tourId,no,revoked]=card,[arrival,departure,pax,active]=tour,extension=d.ext[`${tourId}|${service.date}`];
    Object.assign(result,{person_id:person,person_no:no});
    if(!active)return 'inactive_tour';if(revoked)return 'replaced_card';
    if(service.date<arrival)return 'before_arrival';if(service.date>departure&&!extension)return 'after_departure';
    if(no>pax)return 'over_capacity';if(!service.meal)return 'outside_meal_time';
    if(service.date>departure&&extension!=='day'&&extension!==service.meal)return 'extension_other_meal';
    if(d.servedDate===service.date&&d.served[`${person}|${service.meal}`]){const at=d.served[`${person}|${service.meal}`];if(typeof at==='string')result.firstScannedAt=at;return 'already_scanned';}
    return 'admitted';
  })();
  return {...result,reason,status:reason==='admitted'?'green':'red',message:OFFLINE_REASONS[reason]};
}
function recordServed(result,at){
  const d=offlineData;if(!d||result.status!=='green'||!result.person_id||!result.meal)return;
  if(d.servedDate!==result.date){d.served={};d.servedDate=result.date;}
  d.served[`${result.person_id}|${result.meal}`]=at;store(OFFLINE_DATA_KEY,d);
}
// Offline scans are sent in order; one that the server refuses outright is dropped so it cannot block the rest.
async function sendQueue(){
  while(scanQueue.length){
    const item=scanQueue[0],response=await timedFetch('/api/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:item.code,requestKey:item.requestKey,offlineAt:item.at,offlineStatus:item.status})});
    if(!response.ok&&response.status!==400)throw new Error('Not sent');
    scanQueue.shift();store(OFFLINE_QUEUE_KEY,scanQueue);
  }
}
async function scannerView(){
  await stopScanner();currentView='scanner';
  offlineData=readStored(OFFLINE_DATA_KEY,null);scanQueue=readStored(OFFLINE_QUEUE_KEY,[]);connected=true;
  navigator.serviceWorker?.register('/sw.js',{scope:'/scanner'}).catch(()=>{});
  $('#app').innerHTML=`<div class="scanner-shell"><header class="scanner-head"><h1><img src="${LOGO}" alt="" width="44" height="47">Mawaid scanner</h1><span class="link-chip" id="linkChip"></span></header><small>Faiz-e-Husaini Karbala · Karbala time</small><div class="scan-result" id="scanResult" role="status" aria-live="assertive"><strong>Connecting…</strong></div><div class="camera-box" id="reader"></div><button class="primary" id="startCamera">Start camera</button><p class="scan-tip" id="scanTip">Hold one QR inside the frame. Green screen and a high beep: admit. Red screen and a buzzer: do not admit.</p><details class="manual"><summary>Use a USB scanner or enter a QR value</summary><form id="manualScan"><input id="manualCode" aria-label="QR code value" placeholder="MW1:…" autocomplete="off" required><button id="manualSubmit">Scan</button></form></details><p class="status-note" id="scannerStatus"></p>${role==='admin'?'<a href="/">Back to printing system</a>':''}</div><div class="flash" id="flash" hidden><strong></strong><span></span></div>`;
  $('#app').addEventListener('pointerdown',unlockAudio);$('#app').addEventListener('keydown',unlockAudio);
  $('#flash').onclick=()=>{$('#flash').hidden=true;};
  let lastCode='',lastAt=0;
  const ready=()=>{if(!scannerBusy&&Date.now()-lastAt>=5000){if(service?.meal)showResult('','Ready to scan',`${service.mealLabel} · ${service.date}${connected?'':' · Offline'}`);}};
  const showLink=()=>{
    const cards=offlineData?Object.keys(offlineData.cards).length:0,list=offlineData?.updatedAt?` · ${number(cards)} cards on this phone, updated ${clock12(offlineData.updatedAt)}`:'',waiting=scanQueue.length?` · ${number(scanQueue.length)} offline scan${scanQueue.length===1?'':'s'} waiting to send`:'';
    $('#linkChip').textContent=connected?'Online':'Offline';$('#linkChip').className=`link-chip ${connected?'online':'offline'}`;
    $('#scannerStatus').textContent=`${service?.date||today()} · Karbala · ${connected?'Device connected':'No connection: cards are checked on this phone'}${list}${waiting}`;
  };
  const goOffline=()=>{
    connected=false;if(currentView!=='scanner')return;
    if(offlineData?.cardCursor)service={...service,...karbalaService(new Date(),offlineData.meals)};
    showLink();
    if(!offlineData?.cardCursor&&!scannerBusy)showResult('red','Connection unavailable','This phone has no card list yet. Admission is blocked until the server is reachable.');else ready();
    clearTimeout(retryTimer);retryTimer=setTimeout(()=>void update(),15000);
  };
  // One request a minute keeps the phone's card list current; it reads only what changed since the last one.
  const update=async()=>{
    if(document.hidden||currentView!=='scanner')return;
    try{await sendQueue();const next=await pollOfflineData();if(currentView!=='scanner')return;connected=true;clearTimeout(retryTimer);service=next;showLink();ready();}
    catch{if(currentView==='scanner')goOffline();}
  };
  const cameraButton=()=>{$('#startCamera').textContent=camera?'Stop camera':'Start camera';$('#startCamera').classList.toggle('primary',!camera);};
  async function stopScannerCamera(){if(camera){const running=camera;camera=null;try{await running.stop();}catch{}try{running.clear();}catch{}}cameraButton();}
  async function checkCard(code,requestKey,at){
    if(connected){
      try{
        const response=await timedFetch('/api/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code,requestKey})});
        const result=await response.json();if(!response.ok)return {status:'red',message:result.error||'Card could not be checked.'};
        return result;
      }catch{goOffline();}
    }
    if(!offlineData?.cardCursor||!window.crypto?.subtle)return {status:'red',message:'No connection and no card list on this phone. Admission is blocked.'};
    // The same request key is reused, so a scan that did reach the server before the connection dropped is not counted twice.
    const result=await checkOffline(code,at);
    scanQueue.push({code,requestKey,at:at.toISOString(),status:result.status});store(OFFLINE_QUEUE_KEY,scanQueue);showLink();
    return result;
  }
  async function submit(code){
    if(scannerBusy)return; if(code===lastCode&&Date.now()-lastAt<3000)return;
    scannerBusy=true;lastCode=code;lastAt=Date.now();
    showResult('','Checking card…','Please wait for the result.');
    const at=new Date();
    let result;try{result=await checkCard(code,crypto.randomUUID(),at);}catch{result={status:'red',message:'No confirmed admission. Check the scan log before retrying.'};}
    recordServed(result,at.toISOString());
    const duplicate=result.reason==='already_scanned',title=result.status==='green'?'ALLOW':duplicate?'ALREADY SCANNED':'DO NOT ADMIT';
    const detail=[result.message+(duplicate&&result.firstScannedAt?`, at ${clock12(result.firstScannedAt)}`:''),result.person_no?`Person ${result.person_no}`:'',result.offline?'Checked offline':''].filter(Boolean).join(' · ');
    showResult(result.status==='green'?'green':'red',title,detail);flash(result.status==='green',title,detail);
    beep(result.status==='green',duplicate);
    setTimeout(()=>{scannerBusy=false;},1300);
    setTimeout(()=>{if(Date.now()-lastAt>=4900)ready();},5000);
  }
  $('#startCamera').onclick=()=>guard(()=>busy($('#startCamera'),async()=>{
    unlockAudio();
    if(camera)return stopScannerCamera();
    if(!window.isSecureContext)throw new Error('Camera access requires HTTPS.');if(!window.MawaidCamera)throw new Error('Camera library did not load. Reload the page.');
    const starting=new window.MawaidCamera('reader');
    try{await starting.start({facingMode:'environment'},{fps:20,qrbox:{width:220,height:220}},decoded=>submit(decoded),()=>{});}
    catch(err){try{starting.clear();}catch{}throw new Error(/NotAllowed|Permission/i.test(String(err?.name||err))?'Camera access was blocked. Allow the camera for this site in your browser settings, then try again.':'The camera could not start. Close other apps using the camera, or use a USB scanner.');}
    camera=starting;cameraButton();
  }));
  $('#manualScan').onsubmit=ev=>{ev.preventDefault();const input=$('#manualCode');submit(input.value.trim());input.value='';input.focus();};
  await update();
  // Hidden phones make no periodic requests.
  scannerVisibility=()=>{if(!document.hidden)void update();};
  document.addEventListener('visibilitychange',scannerVisibility);
  scannerTimer=setInterval(update,60000);
}
function showResult(color,title,detail){const box=$('#scanResult');if(!box)return;box.className=`scan-result ${color}`;box.innerHTML=`<strong>${e(title)}</strong><small>${e(detail)}</small>`;}
// A full-screen colour flash, so gate staff can see the result while watching the queue. Tap to dismiss.
function flash(green,title,detail){
  const box=$('#flash');if(!box)return;
  box.className=`flash ${green?'green':'red'}`;$('strong',box).textContent=title;$('span',box).textContent=detail;box.hidden=false;
  clearTimeout(flash.timer);flash.timer=setTimeout(()=>{box.hidden=true;},green?1200:2500);
}
// One audio context, unlocked by the first tap: phones block sound until the page has been touched.
let audio=null;
function unlockAudio(){try{audio??=new(window.AudioContext||window.webkitAudioContext)();if(audio.state==='suspended')audio.resume();}catch{}}
function tone(frequency,start,length,type,volume){const osc=audio.createOscillator(),gain=audio.createGain();osc.type=type;osc.frequency.value=frequency;gain.gain.setValueAtTime(volume,start);gain.gain.setValueAtTime(volume,start+length*.8);gain.gain.linearRampToValueAtTime(0,start+length);osc.connect(gain);gain.connect(audio.destination);osc.start(start);osc.stop(start+length);}
// Green: two short high beeps. Red: a long low buzzer; a duplicate scan buzzes twice.
function beep(green,duplicate=false){
  try{
    unlockAudio();if(!audio)return;const t=audio.currentTime+.02;
    if(green){tone(1800,t,.09,'sine',.6);tone(2400,t+.12,.12,'sine',.6);}
    else for(const at of duplicate?[0,.4]:[0]){const length=duplicate?.3:.7;tone(150,t+at,length,'sawtooth',.5);tone(155,t+at,length,'square',.35);}
  }catch{}
  if(!green)try{navigator.vibrate?.(duplicate?[150,100,150]:[400]);}catch{}
}
(async()=>{try{role=(await api('/session')).role;}catch{if(location.pathname!=='/scanner')return login();}await route();})();
