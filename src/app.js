(() => {
  'use strict';
  const LAST_VISIT_KEY = 'auctionRadar.multisource.lastVisit.v1';
  let feed = {items:[],sources:{}};
  let weekly = {snapshots:[]};

  const $ = id => document.getElementById(id);
  const euro = v => v==null || v==='' ? '—' : new Intl.NumberFormat('el-GR',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(Number(v));
  const num = v => v==null || v==='' ? '—' : new Intl.NumberFormat('el-GR',{maximumFractionDigits:2}).format(Number(v));
  const pct = v => v==null || v==='' ? '—' : new Intl.NumberFormat('el-GR',{style:'percent',minimumFractionDigits:1,maximumFractionDigits:1}).format(Number(v));
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const srcClass = s => s==='eAuction24'?'src-eauction24':s==='Prosperty'?'src-prosperty':'src-delfi';
  const sourceBadge = s => `<span class="source ${srcClass(s)}">${esc(s)}</span>`;
  const link = r => r.url ? `<a class="link" href="${esc(r.url)}" target="_blank" rel="noopener">Άνοιγμα ↗</a>` : '—';
  const psm = r => r.price && r.sqm ? Number(r.price)/Number(r.sqm) : null;
  const dt = s => s ? new Date(s) : null;

  function strategyLabel(m){
    const s=m?.strategy;
    if(s==='immediate_sale') return `<span class="badge badge-new">ΑΜΕΣΗ ΠΩΛΗΣΗ</span>`;
    if(s==='three_year_hold') return `<span class="badge badge-change">3ΕΤΗΣ ΕΚΜΕΤΑΛΛΕΥΣΗ</span>`;
    if(s==='both') return `<span class="badge badge-active">ΚΑΙ ΤΑ ΔΥΟ</span>`;
    return `<span class="badge badge-removed">ΧΡΕΙΑΖΕΤΑΙ ΕΚΤΙΜΗΣΗ</span>`;
  }
  function immediateRoiCell(m){
    if(m?.immediateSaleROI==null) return '—';
    const target=m.immediateSaleTarget50 ? ' ✓ ≥50%' : '';
    return `<strong>${pct(m.immediateSaleROI)}</strong><div class="muted">${target||'στόχος ≥50%'}</div>`;
  }

  function segmentOf(r){
    try { return AuctionRadarPhase1.classifySegment(r); } catch(_) { return r.segment || 'thessaloniki'; }
  }
  function currentFilters(){ return {source:$('sourceFilter').value,segment:$('segmentFilter').value}; }
  function filtered(items){
    const f=currentFilters();
    return items.filter(r => (f.source==='all'||r.source===f.source) && (f.segment==='all'||segmentOf(r)===f.segment));
  }
  function isNewSinceLastVisit(r){
    const last = localStorage.getItem(LAST_VISIT_KEY);
    if(!last) return r.status==='NEW' || true;
    const first = dt(r.first_seen);
    return first && first > new Date(last);
  }
  function statusBadge(status){
    const s=(status||'ACTIVE').toUpperCase();
    const cls=s==='NEW'?'badge-new':s==='CHANGE'?'badge-change':s==='REMOVED'?'badge-removed':'badge-active';
    const label=s==='NEW'?'ΝΕΟ':s==='CHANGE'?'ΑΛΛΑΓΗ':s==='REMOVED'?'ΑΦΑΙΡΕΘΗΚΕ':'ΕΝΕΡΓΟ';
    return `<span class="badge ${cls}">${label}</span>`;
  }
  function row(r, withStatus=true){
    return `<tr>${withStatus?`<td>${statusBadge(isNewSinceLastVisit(r)?'NEW':r.status)}</td>`:''}<td>${sourceBadge(r.source)}</td><td><strong>${esc(r.title||'Ακίνητο')}</strong><div class="muted">${esc(r.flags?.join(' · ')||'')}</div></td><td>${esc(r.address||r.location||'—')}</td><td>${num(r.sqm)}</td><td><strong>${euro(r.price)}</strong></td><td>${psm(r)?euro(psm(r)):'—'}</td>${withStatus?'':`<td>${esc(r.transaction||r.category||'—')}</td>`}<td>${link(r)}</td></tr>`;
  }

  function ingestFeed(){
    const records=(feed.items||[]).filter(r=>r.active!==false).map(r=>({
      id:r.key||r.id, title:r.title, address:r.address, sqm:r.sqm, price:r.price,
      auction_date:r.auction_date, source:r.source, url:r.url, type:r.type,
      description:[r.transaction,(r.flags||[]).join(' ')].filter(Boolean).join(' ')
    }));
    if(records.length) AuctionRadarPhase1.ingest(records);
  }

  function render(){
    const items=filtered((feed.items||[]).filter(r=>r.active!==false));
    const newItems=items.filter(r=>isNewSinceLastVisit(r) || ['NEW','CHANGE'].includes((r.status||'').toUpperCase()));
    $('statCurrent').textContent=items.length;
    $('statNew').textContent=newItems.filter(r=>isNewSinceLastVisit(r)).length;
    $('statChanged').textContent=items.filter(r=>(r.status||'').toUpperCase()==='CHANGE').length;
    const rank=AuctionRadarPhase1.list({segment:currentFilters().segment});
    const rank2=currentFilters().source==='all'?rank:rank.filter(r=>r.source===currentFilters().source);
    $('statRanking').textContent=rank2.length;
    $('statWeek').textContent=weekly.snapshots?.[0]?.week || '—';
    $('updatedAt').textContent='Τελευταία ενημέρωση: '+(feed.updated_at?new Date(feed.updated_at).toLocaleString('el-GR'):'—');
    $('weeklyAt').textContent='Τελευταίο weekly snapshot: '+(weekly.snapshots?.[0]?.saved_at?new Date(weekly.snapshots[0].saved_at).toLocaleString('el-GR'):'—');

    $('newRows').innerHTML=newItems.map(r=>row(r,true)).join('')||'<tr><td colspan="8">Δεν υπάρχουν νέα ή αλλαγές για τα τρέχοντα φίλτρα.</td></tr>';
    $('allRows').innerHTML=items.map(r=>row(r,false)).join('')||'<tr><td colspan="8">Δεν υπάρχουν ενεργά ακίνητα.</td></tr>';
    $('rankRows').innerHTML=rank2.map(r=>{const m=r.metrics||{};return `<tr><td class="score">${m.score??0}</td><td>${strategyLabel(m)}</td><td>${sourceBadge(r.source)}</td><td><strong>${esc(r.title)}</strong><div class="muted">${esc(r.firstSeenDay||'—')}</div></td><td>${esc(r.address||'—')}</td><td>${num(r.sqm)}</td><td>${euro(r.startingPrice)}</td><td>${euro(m.totalCost)}</td><td>${euro(m.immediateSaleProfit)}</td><td>${immediateRoiCell(m)}</td><td>${euro(m.threeYearRentalIncome)}</td><td>${euro(m.threeYearTotalProfit)}</td><td>${pct(m.threeYearROI)}${m.threeYearAnnualizedROI!=null?`<div class="muted">ετησιοπ. ${pct(m.threeYearAnnualizedROI)}</div>`:''}</td><td>${m.pricePerSqm?euro(m.pricePerSqm):'—'}</td><td>${r.url?`<a class="link" href="${esc(r.url)}" target="_blank" rel="noopener">Άνοιγμα ↗</a>`:'—'}</td></tr>`;}).join('')||'<tr><td colspan="15">Δεν υπάρχουν εγγραφές.</td></tr>';
    $('weeklyRows').innerHTML=(weekly.snapshots||[]).map(w=>`<tr><td><strong>${esc(w.week)}</strong></td><td>${esc(w.saved_at?new Date(w.saved_at).toLocaleString('el-GR'):'—')}</td><td>${num(w.total_records)}</td><td>${num(w.new_records)}</td><td><a class="link" href="${esc(w.file)}" target="_blank">JSON ↗</a></td></tr>`).join('')||'<tr><td colspan="5">Δεν υπάρχει ακόμη εβδομαδιαίο snapshot.</td></tr>';

    const chips=[];
    Object.entries(feed.sources||{}).forEach(([name,s])=>{
      chips.push(`<div class="status-chip"><strong>${esc(name)}</strong>: ${s.ok?'OK':'<span class="danger">ERROR</span>'} · ${num(s.count)} εγγραφές${s.error?` · ${esc(s.error)}`:''}</div>`);
    });
    $('sourceStatus').innerHTML=chips.join('');
  }

  async function load(){
    try{
      const bust='?v='+Date.now();
      const [f,w]=await Promise.all([
        fetch('./data/current.json'+bust,{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('current.json '+r.status);return r.json()}),
        fetch('./data/weekly_index.json'+bust,{cache:'no-store'}).then(r=>r.ok?r.json():({snapshots:[]}))
      ]);
      feed=f; weekly=w; ingestFeed(); render();
      localStorage.setItem(LAST_VISIT_KEY,new Date().toISOString());
    }catch(e){
      $('sourceStatus').innerHTML=`<div class="status-chip danger"><strong>Δεν φορτώθηκαν τα live δεδομένα:</strong> ${esc(e.message)}</div>`;
      render();
    }
  }

  document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x===b));
    document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===b.dataset.view));
  }));
  $('sourceFilter').addEventListener('change',render);
  $('segmentFilter').addEventListener('change',render);
  $('reload').addEventListener('click',load);
  $('csv').addEventListener('click',()=>AuctionRadarPhase1.exportCSV({segment:$('segmentFilter').value}));
  $('backup').addEventListener('click',()=>AuctionRadarPhase1.exportJSON());
  load();
})();
