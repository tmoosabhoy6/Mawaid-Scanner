/**
 * Add this as a NEW file in the EXISTING spreadsheet Apps Script project.
 * Namespaced: does not define/replace doGet, flattenZiyaratSchedule, or their helpers.
 * The only trigger created is MAWAYID_refreshTours, every five minutes.
 * No existing trigger is deleted or changed.
 *
 * Script Properties (Project Settings):
 *   MAWAYID_APP_URL       HTTPS origin of this app, no trailing slash
 *   MAWAYID_SYNC_TOKEN    same secret as the app's SYNC_TOKEN
 * Confirmed stay rules: arrival = Pehli Ziyarat; departure = Wada Ziyarat + 1 day.
 * Optional: MAWAYID_DAILY_TIMES     comma-separated HH:mm in Asia/Baghdad;
 *   leave blank for five-minute sync. A daily time runs in the next five-minute tick.
 * Then run MAWAYID_setupTours once and authorise Sheets / UrlFetch / triggers.
 */
var MAWAYID_CONFIG = {
  spreadsheetId: '12JRDK0EmTyO7d07FsOEtp1VHvZg2WGO2HrVLcENEWUE',
  sourceTab: 'KRB - 25', toursTab: 'Tours', cutoff: '2026-10-21',
  // Verified from the live source headers: B=arrival tour ID, Q=Wada tour ID (departure is the next day).
  // Group/office, leader, and PAX follow each ID in the next three columns.
  arrivalIdColumn: 2, departureIdColumn: 17,
  headers: ['Tour ID','Tour Name','Arrival Date','Departure Date','PAX Count']
};
function MAWAYID_setupTours() {
  MAWAYID_refreshTours(true); // Validate, write and push successfully before installing a trigger.
  var triggers = ScriptApp.getProjectTriggers();
  for (var i=0; i<triggers.length; i++) if (triggers[i].getHandlerFunction() === 'MAWAYID_refreshTours') return;
  ScriptApp.newTrigger('MAWAYID_refreshTours').timeBased().everyMinutes(5).create();
}
function MAWAYID_refreshTours(force) {
  var props = PropertiesService.getScriptProperties();
  var url = String(props.getProperty('MAWAYID_APP_URL') || '').replace(/\/$/,'');
  var secret = props.getProperty('MAWAYID_SYNC_TOKEN') || '';
  if (!/^https:\/\/[^/?#]+$/.test(url) || secret.length < 32) throw new Error('Configure MAWAYID_APP_URL and MAWAYID_SYNC_TOKEN in Script Properties.');
  // A user lock avoids competing tours runs without using the existing flatten script's script lock.
  var lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) return;
  try {
    var configResponse=UrlFetchApp.fetch(url+'/api/sync/config',{headers:{Authorization:'Bearer '+secret},muteHttpExceptions:true});
    if(configResponse.getResponseCode()!==200)throw new Error('Could not read app sync settings.');
    var appConfig=JSON.parse(configResponse.getContentText());
    if(appConfig.spreadsheetId!==MAWAYID_CONFIG.spreadsheetId)throw new Error('App source spreadsheet does not match MAWAYID_CONFIG.');
    var destinationTab=appConfig.tab;
    if(destinationTab===MAWAYID_CONFIG.sourceTab || destinationTab==='DB_SEARCHABLE')throw new Error('The source and existing searchable tabs cannot be a tours destination.');
    if(appConfig.requestedAt && (!appConfig.lastSuccess || appConfig.requestedAt>appConfig.lastSuccess))force=true;
    var times = Array.isArray(appConfig.dailyTimes) ? appConfig.dailyTimes.join(',') : (props.getProperty('MAWAYID_DAILY_TIMES') || '').trim();
    var now = new Date();
    var localDate = Utilities.formatDate(now,'Asia/Baghdad','yyyy-MM-dd');
    if (times && force !== true) {
      var clock = Utilities.formatDate(now,'Asia/Baghdad','HH:mm');
      var tick = Number(clock.slice(0,2))*60+Number(clock.slice(3));
      var due = times.split(',').map(function(t){return t.trim();}).filter(function(t){
        if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new Error('Daily times must use HH:mm, e.g. 06:00,12:00,18:00.');
        var minutes = Number(t.slice(0,2))*60+Number(t.slice(3));
        return tick >= minutes && props.getProperty('MAWAYID_LAST_'+t) !== localDate;
      });
      if (!due.length) return;
    }
    var ss = SpreadsheetApp.openById(MAWAYID_CONFIG.spreadsheetId);
    var source = ss.getSheetByName(MAWAYID_CONFIG.sourceTab);
    if (!source) throw new Error('Missing source tab '+MAWAYID_CONFIG.sourceTab);
    var built = MAWAYID_buildTours(source.getDataRange().getDisplayValues(),MAWAYID_CONFIG);
    // Read the configured source before writing: never clear the working source or DB_SEARCHABLE.
    var sheet = ss.getSheetByName(destinationTab) || ss.insertSheet(destinationTab);
    var headers = sheet.getRange(1,1,1,5).getDisplayValues()[0];
    var empty = headers.every(function(h){return !h;}) && sheet.getLastRow()===0;
    if (!empty && headers.join('|') !== MAWAYID_CONFIG.headers.join('|')) throw new Error('Tours tab has unexpected headers; refusing to overwrite it.');
    var values = [MAWAYID_CONFIG.headers].concat(built.tours.map(function(t){return [MAWAYID_sheetText(t.tour_id),MAWAYID_sheetText(t.office),t.arrival,t.departure,t.pax];}));
    // Explicit text format prevents tour IDs/dates being auto-converted by Sheets.
    if (sheet.getMaxRows()<values.length) sheet.insertRowsAfter(sheet.getMaxRows(),values.length-sheet.getMaxRows());
    sheet.getRange(1,1,values.length,4).setNumberFormat('@');
    sheet.getRange(1,1,values.length,5).setValues(values);
    var previousLast = sheet.getLastRow();
    if(previousLast>values.length)sheet.getRange(values.length+1,1,previousLast-values.length,5).clearContent();
    sheet.setFrozenRows(1);
    SpreadsheetApp.flush();
    var payload = { spreadsheetId: ss.getId(), tab: sheet.getName(), tabs: ss.getSheets().map(function(s){return s.getName();}), tours: built.tours, warnings: built.warnings };
    var response = UrlFetchApp.fetch(url+'/api/sync/tours', { method:'post', contentType:'application/json',
      headers:{Authorization:'Bearer '+secret}, payload:JSON.stringify(payload), muteHttpExceptions:true });
    if(response.getResponseCode()!==200)throw new Error('App sync failed (HTTP '+response.getResponseCode()+'). Check app source settings and token.');
    if(times && force!==true)due.forEach(function(t){props.setProperty('MAWAYID_LAST_'+t,localDate);});
    Logger.log('Mawayid Tours sync: '+built.tours.length+' stays; '+built.warnings.length+' warnings.');
    built.warnings.forEach(function(w){Logger.log(w);});
  } finally { lock.releaseLock(); }
}
function MAWAYID_date(value) {
  var months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  var m = String(value).replace(/[\r\n]+/g,' ').trim().match(/^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(\w+)\s+(\d{1,2}),?\s+(20\d{2})$/i);
  if (!m) return null;
  var month = months.indexOf(m[1].toLowerCase()); if(month<0)return null;
  var d = new Date(Date.UTC(Number(m[3]),month,Number(m[2])));
  if(d.getUTCMonth()!==month || d.getUTCDate()!==Number(m[2]))return null;
  return d.toISOString().slice(0,10);
}
function MAWAYID_buildTours(data, config) {
  var groups = {}, date = null, warnings = [], sawArrivalHeader=false, sawDepartureHeader=false;
  data.forEach(function(row, index){
    row.forEach(function(cell){var parsed=MAWAYID_date(cell);if(parsed)date=parsed;});
    if (/Pehli Ziyarat|Pheli Ziyarat/i.test(String(row[config.arrivalIdColumn-1]||''))) sawArrivalHeader=true;
    if (/Wadaa? Ziyarat/i.test(String(row[config.departureIdColumn-1]||''))) sawDepartureHeader=true;
    if(!date)return;
    [[config.arrivalIdColumn-1,'arrivals'],[config.departureIdColumn-1,'departures']].forEach(function(pair){
      var c=pair[0],id=String(row[c]||'').replace(/[\s'"\n]+/g,'');
      if(!/^(?:\d{2}\/\d{1,5}|\d{4})$/.test(id))return;
      var pax=Number(String(row[c+3]||'').replace(/,/g,''));
      var office=String(row[c+1]||'').trim();
      var issue = !office || !Number.isInteger(pax)||pax<1||pax>10000 ? 'Invalid office/PAX in source row '+(index+1)+'. Tours was not updated.' : null;
      if(!groups[id])groups[id]={arrivals:[],departures:[]};
      var events=groups[id][pair[1]], prior=events.filter(function(v){return v.date===date;})[0];
      if(prior && (prior.pax!==pax || prior.office!==office))prior.issue='Conflicting duplicate '+id+' on '+date+' (rows '+prior.row+' and '+(index+1)+'). Tours was not updated.';
      if(!prior)events.push({date:date,office:office,pax:pax,row:index+1,issue:issue});
    });
  });
  if(!sawArrivalHeader||!sawDepartureHeader)throw new Error('Source columns do not match the arrival/departure headers; refusing to change Tours.');
  var tours=[];
  Object.keys(groups).forEach(function(id){
    var g=groups[id];g.arrivals.sort(function(a,b){return a.date.localeCompare(b.date);});g.departures.sort(function(a,b){return a.date.localeCompare(b.date);});
    g.arrivals.forEach(function(arrival,i){
      var next=g.arrivals[i+1];
      var departures=g.departures.filter(function(d){return d.date>=arrival.date && (!next||d.date<next.date);});
      // Validate only stays that can affect launch-day or later entitlements.
      // Keep arrivals before the cutoff when Wada + 1 is on/after it.
      var relevant = arrival.date>=config.cutoff || departures.some(function(d){return MAWAYID_nextDay(d.date)>=config.cutoff;});
      if(!relevant)return;
      if(arrival.issue)throw new Error(arrival.issue);
      departures.forEach(function(d){if(d.issue)throw new Error(d.issue);});
      if(departures.length!==1){if(arrival.date>=config.cutoff || departures.some(function(d){return MAWAYID_nextDay(d.date)>=config.cutoff;}))warnings.push(id+' ('+arrival.date+'): needs exactly one Wada date before the next arrival; excluded.');return;}
      var departure=departures[0];if(MAWAYID_nextDay(departure.date)<config.cutoff)return;
      if(next && MAWAYID_nextDay(departure.date)>=next.date){warnings.push(id+': departure (Wada + 1 day) overlaps the next arrival; excluded.');return;}
      if(departure.pax!==arrival.pax){warnings.push(id+': arrival and Wada PAX differ; excluded.');return;}
      tours.push({tour_id:id,office:arrival.office,arrival:arrival.date,departure:MAWAYID_nextDay(departure.date),pax:arrival.pax});
    });
    g.departures.filter(function(d){return MAWAYID_nextDay(d.date)>=config.cutoff && !g.arrivals.some(function(a){return a.date<=d.date;});}).forEach(function(d){if(d.issue)throw new Error(d.issue);warnings.push(id+' ('+d.date+'): no arrival found; excluded.');});
  });
  tours.sort(function(a,b){return a.arrival.localeCompare(b.arrival)||a.tour_id.localeCompare(b.tour_id);});
  return {tours:tours,warnings:warnings};
}

function MAWAYID_sheetText(value) { return /^[=+@-]/.test(String(value)) ? "'"+value : value; }

function MAWAYID_nextDay(isoDate) {
  var parts=isoDate.split('-').map(Number);
  return new Date(Date.UTC(parts[0],parts[1]-1,parts[2]+1)).toISOString().slice(0,10);
}
