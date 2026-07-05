/**
 * The client-facing scheduling page (Microsoft Bookings look-and-feel),
 * served at GET /book/{token} with no authentication — the unguessable token
 * is the authorization. Fully self-contained HTML: it talks only to the
 * matching public /api/book/{token} endpoints.
 */
export function renderBookingPage(token: string): string {
  const tokenJs = JSON.stringify(token).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Schedule your business review</title>
<style>
:root{--primary:#0b2545;--accent:#1d7874;--ink:#1a1a1a;--muted:#5a6b7b;--line:#dde3ea;--bg:#f2f5f8}
*{box-sizing:border-box}
body{margin:0;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--ink);font-size:15px;line-height:1.5}
.wrap{max-width:920px;margin:0 auto;padding:24px 16px 64px}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;overflow:hidden;box-shadow:0 2px 12px rgba(11,37,69,.06)}
.head{padding:26px 30px 22px;border-bottom:4px solid var(--accent)}
.head img{max-height:44px;max-width:220px;display:block;margin-bottom:14px}
.org{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--accent);margin:0 0 4px}
h1{margin:0 0 6px;font-size:26px;color:var(--primary)}
.desc{margin:0;color:var(--muted)}
.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.chip{background:var(--bg);border:1px solid var(--line);border-radius:99px;padding:4px 12px;font-size:13px;color:var(--primary);font-weight:600}
.body{display:grid;grid-template-columns:1fr 300px;gap:0}
@media(max-width:760px){.body{grid-template-columns:1fr}}
.cal{padding:24px 30px;border-right:1px solid var(--line)}
@media(max-width:760px){.cal{border-right:0;border-bottom:1px solid var(--line)}}
.calhead{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.calhead b{font-size:16px;color:var(--primary)}
.nav{background:#fff;border:1px solid var(--line);border-radius:8px;width:34px;height:34px;font-size:16px;cursor:pointer;color:var(--primary)}
.nav:disabled{opacity:.35;cursor:default}
.grid{display:grid;grid-template-columns:repeat(7,1fr);gap:4px}
.dow{font-size:11px;font-weight:700;color:var(--muted);text-align:center;padding:4px 0;letter-spacing:.04em}
.day{aspect-ratio:1;border:none;background:none;border-radius:99px;font-size:14px;color:var(--ink);cursor:default;position:relative}
.day.avail{background:#e8f3f2;color:var(--primary);font-weight:700;cursor:pointer}
.day.avail:hover{outline:2px solid var(--accent)}
.day.sel{background:var(--accent);color:#fff}
.day.other{color:#c6cdd4}
.slots{padding:24px 26px}
.slots h3{margin:0 0 4px;font-size:15px;color:var(--primary)}
.slots .tz{font-size:12px;color:var(--muted);margin:0 0 14px}
.slotlist{display:flex;flex-direction:column;gap:8px;max-height:340px;overflow-y:auto}
.slot{border:1.5px solid var(--accent);background:#fff;color:var(--accent);border-radius:8px;padding:10px;font-size:14px;font-weight:700;cursor:pointer}
.slot:hover,.slot.sel{background:var(--accent);color:#fff}
.hint{color:var(--muted);font-size:13px}
.form{padding:24px 30px;border-top:1px solid var(--line)}
.form h3{margin:0 0 14px;font-size:16px;color:var(--primary)}
label{display:block;font-size:13px;font-weight:600;color:var(--primary);margin:12px 0 4px}
input,textarea{width:100%;border:1px solid var(--line);border-radius:8px;padding:10px 12px;font:inherit;font-size:14px}
input:focus,textarea:focus{outline:2px solid var(--accent);border-color:transparent}
.cta{margin-top:18px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
.btn{background:var(--accent);border:none;color:#fff;font:inherit;font-weight:700;font-size:15px;border-radius:8px;padding:12px 26px;cursor:pointer}
.btn:disabled{opacity:.5;cursor:default}
.picked{font-size:14px;color:var(--primary);font-weight:700}
.banner{margin:16px 30px;padding:12px 16px;border-radius:8px;font-size:14px}
.banner.err{background:#fdecea;color:#c62828}
.banner.info{background:#e8f3f2;color:#12554f}
.done{padding:48px 30px;text-align:center}
.done .big{font-size:44px}
.done h2{color:var(--primary);margin:10px 0 6px}
.done p{color:var(--muted);margin:4px 0}
.loading{padding:60px;text-align:center;color:var(--muted)}
.foot{margin-top:14px;text-align:center;color:var(--muted);font-size:12px}
</style></head><body>
<div class="wrap">
  <div class="card" id="card"><div class="loading">Loading available times…</div></div>
  <div class="foot" id="foot"></div>
</div>
<script>
(function(){
'use strict';
var TOKEN=${tokenJs};
var API='/api/book/'+encodeURIComponent(TOKEN);
var info=null, monthCache={}, selDay=null, selSlot=null, viewYm=null;
var card=document.getElementById('card');

function esc(s){var d=document.createElement('div');d.textContent=String(s==null?'':s);return d.innerHTML;}
function pad(n){return String(n).padStart(2,'0');}
function ymOf(day){return day.slice(0,7);}
function monthLabel(ym){var d=new Date(ym+'-01T00:00:00Z');return d.toLocaleDateString('en-US',{month:'long',year:'numeric',timeZone:'UTC'});}
function daysInMonth(ym){var y=+ym.slice(0,5-1+1),p=ym.split('-');return new Date(Date.UTC(+p[0],+p[1],0)).getUTCDate();}
function timeLabel(slot){var h=+slot.slice(11,13),m=slot.slice(14,16);var ap=h>=12?'PM':'AM';var hh=h%12===0?12:h%12;return hh+':'+m+' '+ap;}
function dayLabel(day){return new Date(day+'T00:00:00Z').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',timeZone:'UTC'});}

function load(){
  fetch(API).then(function(r){if(!r.ok)throw new Error('This scheduling link is no longer valid.');return r.json();})
  .then(function(j){
    info=j;
    if(j.brand&&j.brand.primary)document.documentElement.style.setProperty('--primary',j.brand.primary);
    if(j.brand&&j.brand.accent)document.documentElement.style.setProperty('--accent',j.brand.accent);
    document.getElementById('foot').textContent='Powered by '+(j.orgName||'Mash IT')+' · Times shown in '+j.tzLabel;
    if(j.status==='booked'){renderBooked(j.booked);return;}
    if(j.status!=='open'){renderGone();return;}
    viewYm=ymOf(j.window.firstDay);
    render();
    loadMonth(viewYm);
  })
  .catch(function(e){card.innerHTML='<div class="done"><div class="big">🔒</div><h2>Link unavailable</h2><p>'+esc(e.message)+'</p><p>Please reach out to your account manager for a new link.</p></div>';});
}

function loadMonth(ym){
  if(monthCache[ym]){paint();return;}
  monthCache[ym]={loading:true};paint();
  var from=ym+'-01', to=ym+'-'+pad(daysInMonth(ym));
  fetch(API+'/slots?from='+from+'&to='+to).then(function(r){return r.ok?r.json():{slots:[]};})
  .then(function(j){monthCache[ym]={slots:j.slots||[],checked:j.calendarChecked};paint();})
  .catch(function(){monthCache[ym]={slots:[],checked:false};paint();});
}

function header(){
  var h='<div class="head">';
  if(info.brand&&info.brand.logo)h+='<img src="'+info.brand.logo+'" alt="">';
  h+='<p class="org">'+esc(info.orgName)+'</p><h1>'+esc(info.title)+'</h1>';
  h+='<p class="desc">For '+esc(info.clientName)+' · '+esc(info.periodLabel)+(info.description?' — '+esc(info.description):'')+'</p>';
  h+='<div class="meta"><span class="chip">⏱ '+info.durationMinutes+' minutes</span><span class="chip">💻 Microsoft Teams</span><span class="chip">🌐 '+esc(info.tzLabel)+'</span></div></div>';
  return h;
}

function render(){
  card.innerHTML=header()+
    '<div class="body"><div class="cal">'+
    '<div class="calhead"><button class="nav" id="prev">‹</button><b id="mon"></b><button class="nav" id="next">›</button></div>'+
    '<div class="grid" id="grid"></div></div>'+
    '<div class="slots"><h3 id="slotday">Pick a date</h3><p class="tz">All times '+esc(info.tzLabel)+'</p><div class="slotlist" id="slotlist"><p class="hint">Choose a highlighted day on the calendar to see open times.</p></div></div></div>'+
    '<div class="form" id="form" style="display:none"><h3>Your details</h3>'+
    '<div class="picked" id="picked"></div>'+
    '<label for="f-name">Name</label><input id="f-name" autocomplete="name" maxlength="120">'+
    '<label for="f-email">Email</label><input id="f-email" type="email" autocomplete="email" maxlength="200">'+
    '<label for="f-extra">Additional attendees (emails, comma-separated — optional)</label><input id="f-extra" maxlength="500">'+
    '<label for="f-notes">Anything you\\'d like covered? (optional)</label><textarea id="f-notes" rows="2" maxlength="1000"></textarea>'+
    '<div class="cta"><button class="btn" id="confirm">Confirm booking</button><span class="hint" id="formhint"></span></div></div>'+
    '<div id="err"></div>';
  document.getElementById('prev').onclick=function(){nav(-1);};
  document.getElementById('next').onclick=function(){nav(1);};
  document.getElementById('confirm').onclick=submit;
  paint();
}

function nav(d){
  var p=viewYm.split('-'),y=+p[0],m=+p[1]+d;
  if(m<1){m=12;y--;}if(m>12){m=1;y++;}
  var ym=y+'-'+pad(m);
  if(ym<ymOf(info.window.firstDay)||ym>ymOf(info.window.lastDay))return;
  viewYm=ym;selDay=null;selSlot=null;hideForm();loadMonth(ym);
}

function paint(){
  if(!info||info.status!=='open')return;
  var mon=document.getElementById('mon');if(!mon)return;
  mon.textContent=monthLabel(viewYm);
  document.getElementById('prev').disabled=viewYm<=ymOf(info.window.firstDay);
  document.getElementById('next').disabled=viewYm>=ymOf(info.window.lastDay);
  var cache=monthCache[viewYm]||{},slots=cache.slots||[];
  var byDay={};slots.forEach(function(s){var d=s.slice(0,10);(byDay[d]=byDay[d]||[]).push(s);});
  var grid=document.getElementById('grid');grid.innerHTML='';
  ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach(function(d){var e=document.createElement('div');e.className='dow';e.textContent=d;grid.appendChild(e);});
  var first=new Date(viewYm+'-01T00:00:00Z'),startDow=first.getUTCDay(),n=daysInMonth(viewYm);
  for(var i=0;i<startDow;i++){var pad0=document.createElement('div');grid.appendChild(pad0);}
  for(var d=1;d<=n;d++){
    var day=viewYm+'-'+pad(d);
    var b=document.createElement('button');b.className='day';b.textContent=String(d);
    if(byDay[day]){b.className='day avail'+(day===selDay?' sel':'');b.onclick=(function(dd){return function(){pickDay(dd);};})(day);}
    else b.disabled=true;
    grid.appendChild(b);
  }
  var list=document.getElementById('slotlist');
  if(cache.loading){list.innerHTML='<p class="hint">Checking the calendar…</p>';return;}
  if(selDay&&byDay[selDay]){
    document.getElementById('slotday').textContent=dayLabel(selDay);
    list.innerHTML='';
    byDay[selDay].forEach(function(s){
      var b=document.createElement('button');b.className='slot'+(s===selSlot?' sel':'');b.textContent=timeLabel(s);
      b.onclick=function(){selSlot=s;showForm();paint();};
      list.appendChild(b);
    });
  } else {
    document.getElementById('slotday').textContent='Pick a date';
    list.innerHTML='<p class="hint">'+(slots.length?'Choose a highlighted day on the calendar to see open times.':'No open times this month — try the arrows for another month.')+'</p>';
  }
}

function pickDay(d){selDay=d;selSlot=null;hideForm();paint();}
function showForm(){
  document.getElementById('form').style.display='block';
  document.getElementById('picked').textContent='📅 '+dayLabel(selSlot.slice(0,10))+' at '+timeLabel(selSlot)+' ('+info.tzLabel+')';
  document.getElementById('form').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function hideForm(){var f=document.getElementById('form');if(f)f.style.display='none';}

function submit(){
  var name=document.getElementById('f-name').value.trim();
  var email=document.getElementById('f-email').value.trim();
  var extra=document.getElementById('f-extra').value.trim();
  var notes=document.getElementById('f-notes').value.trim();
  var hint=document.getElementById('formhint');
  if(!name||!email||email.indexOf('@')<1){hint.textContent='Please enter your name and a valid email.';return;}
  var btn=document.getElementById('confirm');btn.disabled=true;hint.textContent='Booking…';
  fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({start:selSlot,name:name,email:email,attendees:extra?extra.split(',').map(function(s){return s.trim();}).filter(Boolean):[],notes:notes})})
  .then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j&&j.error?j.error:'Booking failed');return j;});})
  .then(function(j){renderBooked(j);})
  .catch(function(e){btn.disabled=false;hint.textContent='';showErr(e.message);if(String(e.message).indexOf('taken')>=0){delete monthCache[viewYm];selSlot=null;hideForm();loadMonth(viewYm);}});
}

function showErr(msg){document.getElementById('err').innerHTML='<div class="banner err">'+esc(msg)+'</div>';}

function renderBooked(b){
  b=b||{};
  card.innerHTML=header()+'<div class="done"><div class="big">✅</div><h2>You\\'re booked!</h2>'+
    '<p><b>'+esc(b.start?dayLabel(b.start.slice(0,10))+' at '+timeLabel(b.start):'')+'</b> ('+esc(info?info.tzLabel:'')+')</p>'+
    '<p>'+(b.inviteSent?'A calendar invitation with the Microsoft Teams link is on its way to your inbox.':'We\\'ll send your calendar invitation with the meeting link shortly.')+'</p>'+
    '<p class="hint">Need to change it? Just reply to the invitation or contact your account manager.</p></div>';
}
function renderGone(){card.innerHTML=header()+'<div class="done"><div class="big">📅</div><h2>This link is closed</h2><p>Please contact your account manager for a new scheduling link.</p></div>';}

load();
})();
</script></body></html>`;
}
