const state = { underlagFiles: [], manual: [], reskontraFiles: [], manualIdentities: {}, mapping: {}, exclusions: {}, invoiceOffset: 1, startUnderlag: '', startReskontra: '', approvedDiffs: {}, birthYears: {}, paymentOverrides: {}, excludedReskontraRows: {} };

// ---------- helpers ----------
function parseSwedishNumber(s){
  if(s===undefined||s===null) return 0;
  s = String(s).replace(/\u00A0/g,' ').trim();
  if(s==='') return 0;
  s = s.replace(/\s+/g,'').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
// escapa text från CSV-filer innan den läggs in via innerHTML — ett '<' eller '&' i en
// beskrivning ska visas som text, inte tolkas som markup. Säkert även i attribut ("...").
function esc(v){
  return String(v ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtNum(n){
  return n.toLocaleString('sv-SE', {minimumFractionDigits:2, maximumFractionDigits:2});
}
function parseCsvLine(line, delim=';'){
  const result=[]; let cur=''; let inQuotes=false;
  for(let i=0;i<line.length;i++){
    const c=line[i];
    if(inQuotes){
      if(c==='"'){
        if(line[i+1]==='"'){cur+='"'; i++;}
        else inQuotes=false;
      } else cur+=c;
    } else {
      if(c==='"') inQuotes=true;
      else if(c===delim){result.push(cur); cur='';}
      else cur+=c;
    }
  }
  result.push(cur);
  return result;
}
function cleanCell(s){
  s = (s||'').trim();
  if(s.length>=2 && s[0]==='"' && s[s.length-1]==='"') s = s.slice(1,-1).trim();
  return s;
}
function monthKeyFromDate(d){
  const m = (d||'').match(/(\d{4})-(\d{2})/);
  return m ? m[1]+'-'+m[2] : (d||'');
}
function shiftMonthKey(mk, deltaMonths){
  const m = (mk||'').match(/^(\d{4})-(\d{2})$/);
  if(!m || !deltaMonths) return mk;
  let y = parseInt(m[1],10), mo = parseInt(m[2],10) + deltaMonths;
  while(mo>12){ mo-=12; y+=1; }
  while(mo<1){ mo+=12; y-=1; }
  return y+'-'+String(mo).padStart(2,'0');
}
const SV_MONTHS = {'januari':'01','februari':'02','mars':'03','april':'04','maj':'05','juni':'06','juli':'07','augusti':'08','september':'09','oktober':'10','november':'11','december':'12'};
function monthKeyFromUnderlag(str){
  str = (str||'').trim();
  if(!str) return '';
  let m = str.match(/(\d{4})-(\d{2})/);
  if(m) return m[1]+'-'+m[2];
  m = str.match(/^(\d{4})(\d{2})$/); // e.g. "202601" -> "2026-01"
  if(m && parseInt(m[2],10)>=1 && parseInt(m[2],10)<=12) return m[1]+'-'+m[2];
  const lower = str.toLowerCase();
  for(const name in SV_MONTHS){
    if(lower.includes(name)){
      const y = str.match(/(\d{4})/);
      return (y?y[1]:'????') + '-' + SV_MONTHS[name];
    }
  }
  return str;
}

// ---------- underlag parsing ----------
let __rowUid = 1;
function nextRowId(){ return __rowUid++; }
// tolkar svenskt personnummer (ÅÅMMDD-XXXX eller ÅÅÅÅMMDD-XXXX) och returnerar bara födelseåret —
// resten av personnumret sparas eller visas aldrig.
function birthYearFromPersonnummer(pnr){
  const digits = (pnr||'').replace(/[^0-9]/g, '');
  if(digits.length===12) return digits.slice(0,4); // ÅÅÅÅMMDDXXXX
  if(digits.length===10){ // ÅÅMMDDXXXX — gissa sekel
    const yy = parseInt(digits.slice(0,2),10);
    const currentYY = new Date().getFullYear() % 100;
    return String((yy<=currentYY ? 2000 : 1900) + yy);
  }
  return '';
}
function parseUnderlagCsv(text){
  const lines = text.split(/\r?\n/).filter(l=>l.trim()!=='');
  const rows = [];
  for(let i=1;i<lines.length;i++){
    const cells = lines[i].split(';').map(c=>cleanCell(c));
    if(cells.length<7) continue;
    rows.push({
      id: nextRowId(),
      manad: cells[1]||'', namn: cells[2]||'',
      mottagare: cells[4]||'', avgift: parseSwedishNumber(cells[5]),
      birthYear: birthYearFromPersonnummer(cells[3])
    });
  }
  return rows;
}


// ---------- kundreskontralista parsing (recommended, per-customer invoices+payments) ----------
// Radmodell:
//  * Kund-/Kreditfaktura MED fakturadatum+förfallodatum = bokföringspost (påverkar Fakturerat).
//  * Kund-/Kreditfaktura UTAN datum = kvittningsrad: paret (kredit −X, faktura +X) betyder
//    "kreditfakturan kvittas mot fakturan med belopp X". Påverkar inte Fakturerat (den daterade
//    kreditposten gör redan det) men talar om VILKEN faktura krediten reglerar.
//  * Inbetalning = betalning (kredit).
function parseReskontraCsv(text){
  const lines = text.split(/\r?\n/);
  let currentKundNr = '', currentKundNamn = '';
  const out = [];
  // skydd mot exakta dubblettrader (samma rad två gånger i filen). Jämför HELA raden — två rader som
  // bara delar vernr/fakturanr/belopp men skiljer sig i t.ex. datum eller text är legitima och behålls.
  const seenLines = new Set();
  const idCount = new Map(); // id-format oförändrat (sparade uteslutningar refererar till det); krockar får suffix
  for(let i=0;i<lines.length;i++){
    if(lines[i].trim()==='') continue;
    const cells = parseCsvLine(lines[i]).map(cleanCell);
    const custMatch = cells[0] && cells[0].match(/^(\d+)\s*-\s*(.+)$/);
    if(custMatch){
      currentKundNr = custMatch[1];
      currentKundNamn = custMatch[2].trim();
      continue;
    }
    if(cells[0] === 'Verifikationsnummer') continue; // column header line, repeats per customer block
    if(!cells[0]) continue; // pre-customer summary lines etc.
    if(!currentKundNr) continue; // stray line before any customer block
    const [vernr, verdatum, beskrivning, fakturanummerKolumn, fakturadatum, forfallodatum, beloppRaw] = cells;
    if(!verdatum) continue;
    const belopp = parseSwedishNumber((beloppRaw||'').replace(/SEK/gi,''));
    // matchning sker alltid mot den sista siffergruppen i beskrivningstexten (t.ex. "...Nilsson  2954" -> 2954),
    // oavsett om Fakturanummer-kolumnen är ifylld — mer konsekvent än att blanda källor.
    const descMatch = (beskrivning||'').match(/(\d+)\s*$/);
    const fakturanr = descMatch ? descMatch[1] : (fakturanummerKolumn||'');
    const hasDates = !!(fakturadatum && forfallodatum);
    const lineSig = currentKundNr + '\u0001' + cells.join('\u0001');
    if(seenLines.has(lineSig)) continue;
    seenLines.add(lineSig);
    const baseSig = `${currentKundNr}|${vernr}|${fakturanr}|${belopp}|${hasDates?'d':'u'}`;
    const n = (idCount.get(baseSig) || 0) + 1;
    idCount.set(baseSig, n);
    const sig = n===1 ? baseSig : `${baseSig}#${n}`;

    const beskrLower = (beskrivning||'').toLowerCase();
    const isFakturaRad = beskrLower.includes('kundfaktura') || beskrLower.includes('kreditfaktura');
    let debet = 0, kredit = 0, typ = 'ovrigt', kvittningsBelopp = 0, note = '';

    if(isFakturaRad && !hasDates){
      // kvittningsrad: positiv = fakturan som tar emot kvittningen, negativ = krediten som förbrukas
      typ = 'kvittning';
      kvittningsBelopp = belopp;
      note = 'Kvittningsrad — kopplar kredit till faktura, räknas ej i Fakturerat';
    } else if(beskrLower.includes('kreditfaktura')){
      typ = 'kreditfaktura'; debet = belopp; // behåller sitt (negativa) tecken
    } else if(beskrLower.includes('kundfaktura')){
      typ = 'kundfaktura'; debet = belopp;
    } else if(beskrLower.includes('inbetalning')){
      typ = 'inbetalning'; kredit = -belopp;
    } else {
      // okänd radtyp — fall tillbaka på teckenbaserad gissning
      debet = belopp>0 ? belopp : 0;
      kredit = belopp<0 ? -belopp : 0;
    }

    out.push({
      id: sig,
      kundNr: currentKundNr, kundNamn: currentKundNamn,
      vernr, datum: verdatum, beskrivning, typ, note, kvittningsBelopp,
      fakturanr, fakturadatum: fakturadatum||'', forfallodatum: forfallodatum||'',
      debet, kredit
    });
  }
  return out;
}

// svenska ekonomisystem (Fortnox, Visma m.fl.) exporterar ofta CSV i Windows-1252, inte UTF-8.
// Läs som UTF-8 först; om det ger ogiltiga tecken (U+FFFD) — typiskt för å/ä/ö i Windows-1252
// feltolkat som UTF-8 — läs om samma fil som Windows-1252 istället.
function decodeFileBuffer(buffer){
  const utf8 = new TextDecoder('utf-8', {fatal:false}).decode(buffer);
  if(utf8.indexOf('�') === -1) return utf8;
  try {
    return new TextDecoder('windows-1252').decode(buffer);
  } catch(e){
    return utf8;
  }
}

// multi-file wiring for underlag
function wireDropMulti(dropId, inputId, onFiles){
  const drop = document.getElementById(dropId);
  const input = document.getElementById(inputId);
  drop.addEventListener('click', ()=>input.click());
  drop.addEventListener('dragover', e=>{e.preventDefault(); drop.classList.add('over');});
  drop.addEventListener('dragleave', ()=>drop.classList.remove('over'));
  drop.addEventListener('drop', e=>{
    e.preventDefault(); drop.classList.remove('over');
    handleFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', e=>{
    handleFiles(e.target.files);
    input.value = ''; // allow re-adding same filename later
  });
  function handleFiles(fileList){
    const files = Array.from(fileList);
    let remaining = files.length;
    if(remaining===0) return;
    files.forEach(file=>{
      const reader = new FileReader();
      reader.onload = ()=>{
        const text = decodeFileBuffer(reader.result);
        onFiles(text, file.name);
        remaining--;
      };
      reader.readAsArrayBuffer(file);
    });
  }
}

wireDropMulti('drop-underlag','file-underlag', (text, name)=>{
  const rows = parseUnderlagCsv(text);
  const existingIdx = state.underlagFiles.findIndex(f=>f.name===name);
  if(existingIdx>-1) state.underlagFiles[existingIdx] = {name, rows};
  else state.underlagFiles.push({name, rows});
  // fyll i födelseår automatiskt från personnumret i CSV:n, men skriv aldrig över
  // ett värde som redan är manuellt satt (i tabellen eller från en tidigare fil).
  rows.forEach(r=>{
    if(r.birthYear && !state.birthYears[r.namn]) state.birthYears[r.namn] = r.birthYear;
  });
  renderUnderlagFileList();
  renderUnderlagTable();
  renderBirthYearTable();
  renderMappingTable();
  renderExclusionsTable();
});

wireDropMulti('drop-reskontra','file-reskontra', (text, name)=>{
  const rows = parseReskontraCsv(text);
  const existingIdx = state.reskontraFiles.findIndex(f=>f.name===name);
  if(existingIdx>-1) state.reskontraFiles[existingIdx] = {name, rows};
  else state.reskontraFiles.push({name, rows});
  renderReskontraFileList();
  renderMappingTable();
});

function allReskontraRowsRaw(){
  return state.reskontraFiles.flatMap(f=>f.rows);
}
function allReskontraRows(){
  // exkluderar rader som manuellt flaggats bort i "Alla transaktioner"-granskningen
  return allReskontraRowsRaw().filter(r=>!state.excludedReskontraRows[r.id]);
}
// använder en manuell betalning→faktura-koppling om en sådan satts (t.ex. när Beskrivning
// saknar ett utläsbart fakturanummer), annars det automatiskt tolkade fakturanumret.
// Kopplingen nycklas på radens id (unikt per kund+rad) — inte vernr, som kan återkomma hos flera
// kunder/filer — och gäller bara inbetalningar (kredit), aldrig fakturarader.
function effectiveFakturanr(t){
  if(t.kredit>0 && state.paymentOverrides[t.id]) return state.paymentOverrides[t.id];
  return t.fakturanr;
}
// datum som avgör vilken månad en rad hör till: fakturadatum för fakturarader, annars verifikationsdatum
function rowMonthDate(t){
  return (t.debet!==0 && t.fakturadatum) ? t.fakturadatum : t.datum;
}
// regleringsstatus för ett belopp (faktura >0, kreditfaktura <0) givet reglerat belopp i samma tecken
function settleStatusTag(belopp, settled, {creditOnly=false}={}){
  const rest = belopp - settled;
  if(belopp < 0){
    if(Math.abs(rest) < 1) return '<span class="tag ok">Kvittad</span>';
    if(rest >= 1) return `<span class="tag warn">Överkvittad ${fmtNum(rest)}</span>`;
    if(settled < 0) return `<span class="tag pay-warn">Delvis kvittad, ${fmtNum(-rest)} kvar</span>`;
    return '<span class="tag cross">Kreditfaktura (ej kvittad)</span>';
  }
  if(Math.abs(rest) < 1) return creditOnly ? '<span class="tag ok">Krediterad</span>' : '<span class="tag ok">Betald</span>';
  if(rest <= -1) return `<span class="tag warn">Överbetald ${fmtNum(-rest)}</span>`;
  if(settled > 0) return `<span class="tag pay-warn">Delvis, ${fmtNum(rest)} kvar</span>`;
  return '<span class="tag warn">Obetald</span>';
}
// äldre exporter nycklade kopplingar på vernr; flytta dem till rad-id för de inbetalningar som har det vernr
function migratePaymentOverrides(){
  const ov = state.paymentOverrides;
  const rows = allReskontraRowsRaw();
  Object.keys(ov).forEach(key=>{
    if(key.includes('|')) return; // redan rad-id
    rows.filter(t=>t.vernr===key && t.kredit>0).forEach(t=>{ if(!ov[t.id]) ov[t.id] = ov[key]; });
    delete ov[key];
  });
}
function renderReskontraFileList(){
  const el = document.getElementById('filelist-reskontra');
  const statusEl = document.getElementById('status-reskontra');
  el.innerHTML = '';
  if(state.reskontraFiles.length===0){
    statusEl.textContent = 'Inga filer inlästa.';
    statusEl.classList.remove('ok');
    return;
  }
  let totalRows = 0;
  state.reskontraFiles.forEach((f, idx)=>{
    totalRows += f.rows.length;
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="fname">${esc(f.name)}</span><span class="fcount">${f.rows.length} transaktioner</span></span>
      <button class="frem" data-idx="${idx}" title="Ta bort fil">✕</button>`;
    el.appendChild(li);
  });
  statusEl.textContent = `${state.reskontraFiles.length} fil(er), ${totalRows} transaktioner totalt.`;
  statusEl.classList.add('ok');
  el.querySelectorAll('[data-idx]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      state.reskontraFiles.splice(parseInt(btn.dataset.idx),1);
      renderReskontraFileList();
      renderMappingTable();
    });
  });
}

// ---------- underlag file list ----------
function renderUnderlagFileList(){
  const el = document.getElementById('filelist-underlag');
  const statusEl = document.getElementById('status-underlag');
  el.innerHTML = '';
  if(state.underlagFiles.length===0){
    statusEl.textContent = 'Inga filer inlästa.';
    statusEl.classList.remove('ok');
    return;
  }
  let totalRows = 0;
  state.underlagFiles.forEach((f, idx)=>{
    totalRows += f.rows.length;
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="fname">${esc(f.name)}</span><span class="fcount">${f.rows.length} rader</span></span>
      <button class="frem" data-idx="${idx}" title="Ta bort fil">✕</button>`;
    el.appendChild(li);
  });
  statusEl.textContent = `${state.underlagFiles.length} fil(er), ${totalRows} rader totalt.`;
  statusEl.classList.add('ok');
  el.querySelectorAll('[data-idx]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      state.underlagFiles.splice(parseInt(btn.dataset.idx),1);
      renderUnderlagFileList();
      renderUnderlagTable();
  renderBirthYearTable();
      renderMappingTable();
  renderExclusionsTable();
    });
  });
}

// ---------- underlag table (incl manual) ----------
function allUnderlagRows(){
  return state.underlagFiles.flatMap(f=>f.rows).concat(state.manual);
}
// beräknar "fyllda år" det kalenderår raden avser, och returnerar CSS-klass för färgkodning:
// 1-2 år = röd, 3 år = orange, 4+ år = grön. Saknas födelseår ges ingen färg.
function ageClassForRow(namn, manad){
  const birthYear = state.birthYears[namn];
  if(!birthYear) return '';
  const mk = monthKeyFromUnderlag(manad);
  const yearMatch = mk.match(/^(\d{4})/);
  if(!yearMatch) return '';
  const rowYear = parseInt(yearMatch[1], 10);
  const age = rowYear - parseInt(birthYear, 10);
  if(age===1 || age===2) return 'age-red';
  if(age===3) return 'age-orange';
  if(age>=4) return 'age-green';
  return '';
}
function renderBirthYearTable(){
  const tbody = document.querySelector('#tbl-birthyears tbody');
  tbody.innerHTML = '';
  const namn = [...new Set(allUnderlagRows().map(r=>r.namn).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'sv'));
  if(namn.length===0){
    tbody.innerHTML = '<tr><td colspan="2" class="empty">Läs in underlag först.</td></tr>';
    return;
  }
  namn.forEach(n=>{
    const tr = document.createElement('tr');
    const val = state.birthYears[n] || '';
    tr.innerHTML = `<td>${esc(n)}</td><td><input type="number" class="birthyear-input" data-namn="${esc(n)}" value="${esc(val)}" placeholder="ÅÅÅÅ" min="1990" max="2030"></td>`;
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.birthyear-input').forEach(inp=>{
    inp.addEventListener('change', ()=>{
      const v = inp.value.trim();
      if(v) state.birthYears[inp.dataset.namn] = v;
      else delete state.birthYears[inp.dataset.namn];
      renderUnderlagTable();
    });
  });
}
function renderUnderlagTable(){
  const tbody = document.querySelector('#tbl-underlag tbody');
  tbody.innerHTML = '';
  const rows = allUnderlagRows();
  const nonManualCount = rows.length - state.manual.length;
  document.getElementById('underlag-row-count').textContent = rows.length;
  if(rows.length===0){
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Inga rader ännu.</td></tr>';
    return;
  }
  const nameFilter = (document.getElementById('underlag-name-filter').value || '').toLowerCase().trim();
  let visibleCount = 0;
  rows.forEach((r, idx)=>{
    if(nameFilter && !(r.namn||'').toLowerCase().includes(nameFilter)) return;
    visibleCount++;
    const isManual = idx >= nonManualCount;
    const manualIdx = idx - nonManualCount;
    const tr = document.createElement('tr');
    const ageClass = ageClassForRow(r.namn, r.manad);
    if(ageClass) tr.classList.add(ageClass);
    tr.innerHTML = `<td>${esc(monthKeyFromUnderlag(r.manad))}</td><td>${esc(r.namn)}</td>
      <td>${esc(r.mottagare)}</td><td class="num">${fmtNum(r.avgift)}</td>
      <td>${isManual ? `<button class="pill-btn" data-del="${manualIdx}">✕</button>` : ''}</td>`;
    tbody.appendChild(tr);
  });
  if(visibleCount===0){
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Inga rader matchar filtret.</td></tr>';
  }
  tbody.querySelectorAll('[data-del]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      state.manual.splice(parseInt(btn.dataset.del),1);
      renderUnderlagTable();
  renderBirthYearTable();
      renderMappingTable();
  renderExclusionsTable();
    });
  });
}
document.getElementById('underlag-name-filter').addEventListener('input', renderUnderlagTable);

document.getElementById('add-manual').addEventListener('click', ()=>{
  const row = {
    id: nextRowId(),
    manad: document.getElementById('m-manad').value,
    namn: document.getElementById('m-namn').value,
    mottagare: document.getElementById('m-mottagare').value,
    avgift: parseFloat(document.getElementById('m-avgift').value)||0
  };
  if(!row.namn){ alert('Namn krävs.'); return; }
  state.manual.push(row);
  renderUnderlagTable();
  renderBirthYearTable();
  renderMappingTable();
  renderExclusionsTable();
});

document.getElementById('clear-manual-form').addEventListener('click', ()=>{
  ['m-manad','m-namn','m-mottagare','m-avgift'].forEach(id=>document.getElementById(id).value='');
});

// ---------- mapping table ----------
function ledgerIdentities(){
  const map = new Map();
  // manuellt tillagda kunder (t.ex. inga fakturor ännu) — lägre prioritet, skrivs över av verklig data
  Object.entries(state.manualIdentities).forEach(([kundNr, kundNamn])=>{
    map.set(kundNr, kundNamn);
  });
  // kundreskontralistan är säkrast (explicit kundblock) — högsta prioritet
  allReskontraRows().forEach(r=>{
    if(!r.kundNr) return;
    map.set(r.kundNr, r.kundNamn || map.get(r.kundNr) || '');
  });
  return map; // kundNr -> kundNamn
}
function getMappingEntries(namn){
  // migrate legacy single-string mapping to array format
  const existing = state.mapping[namn];
  if(Array.isArray(existing)) return existing;
  if(typeof existing === 'string' && existing){
    state.mapping[namn] = [{kundNr: existing, percent: 100}];
    return state.mapping[namn];
  }
  state.mapping[namn] = [{kundNr: '', percent: 100}];
  return state.mapping[namn];
}

// ---------- manuellt tillagda kunder (t.ex. ingen faktura ännu) ----------
function renderManualKundList(){
  const el = document.getElementById('manual-kund-list');
  el.innerHTML = '';
  const entries = Object.entries(state.manualIdentities);
  entries.sort((a,b)=>a[0].localeCompare(b[0])).forEach(([kundNr, kundNamn])=>{
    const li = document.createElement('li');
    li.innerHTML = `<span><span class="fname">${esc(kundNr)}</span><span class="fcount">${esc(kundNamn)}</span></span>
      <button class="frem" data-kundnr="${esc(kundNr)}" title="Ta bort">✕</button>`;
    el.appendChild(li);
  });
  el.querySelectorAll('[data-kundnr]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      delete state.manualIdentities[btn.dataset.kundnr];
      renderManualKundList();
      renderMappingTable();
    });
  });
}
document.getElementById('add-manual-kund').addEventListener('click', ()=>{
  const kundNr = document.getElementById('m-kundnr').value.trim();
  const kundNamn = document.getElementById('m-kundnamn').value.trim();
  if(!kundNr){ alert('Kundnr krävs.'); return; }
  state.manualIdentities[kundNr] = kundNamn;
  document.getElementById('m-kundnr').value = '';
  document.getElementById('m-kundnamn').value = '';
  renderManualKundList();
  renderMappingTable();
});

function renderMappingTable(){
  const tbody = document.querySelector('#tbl-mapping tbody');
  tbody.innerHTML = '';
  const rows = allUnderlagRows();
  const byNamn = new Map();
  rows.forEach(r=>{
    if(!r.namn) return;
    if(!byNamn.has(r.namn)) byNamn.set(r.namn, {mottagare: new Set(), anyActive: false});
    const entry = byNamn.get(r.namn);
    entry.mottagare.add(r.mottagare);
    if(!findExclusionForRow(r)) entry.anyActive = true;
  });
  // hide names whose every row falls within an "ej fakturering"-period — nothing to map
  [...byNamn.keys()].forEach(namn=>{
    if(!byNamn.get(namn).anyActive) byNamn.delete(namn);
  });
  if(byNamn.size===0){
    tbody.innerHTML = '<tr><td colspan="3" class="empty">Läs in underlag först.</td></tr>';
    return;
  }
  const identities = ledgerIdentities();
  const identityOptions = [...identities.entries()].map(([nr,nm])=>`<option value="${esc(nr)}">${esc(nr)} — ${esc(nm)}</option>`).join('');
  const unmappedOnly = document.getElementById('mapping-unmapped-only').checked;

  let shown = 0;
  [...byNamn.entries()].sort((a,b)=>a[0].localeCompare(b[0],'sv')).forEach(([namn, info])=>{
    const mottagareSet = info.mottagare;
    const entries = getMappingEntries(namn);
    const isMapped = entries.some(e=>e.kundNr);
    if(unmappedOnly && isMapped) return;
    shown++;
    const tr = document.createElement('tr');
    const multi = entries.length > 1;
    const sum = entries.reduce((s,e)=>s + (e.kundNr ? (Number(e.percent)||0) : 0), 0);
    const sumOk = !multi || Math.abs(sum-100) < 0.01;

    let entriesHtml = entries.map((entry, i)=>`
      <div class="split-row">
        <select data-namn="${esc(namn)}" data-idx="${i}" class="split-select">
          <option value="">— ej mappad —</option>
          ${identityOptions}
        </select>
        ${multi ? `<input type="number" class="split-percent" data-namn="${esc(namn)}" data-idx="${i}" value="${entry.percent}" min="0" max="100" step="1">%` : ''}
        ${multi ? `<button class="pill-btn" data-remove="${esc(namn)}|${i}" title="Ta bort delning">✕</button>` : ''}
      </div>`).join('');

    entriesHtml += `<button class="split-add" data-addsplit="${esc(namn)}">+ dela på fler kunder</button>`;
    if(multi){
      entriesHtml += `<span class="split-sum ${sumOk?'':'split-sum-bad'}">Summa: ${sum}%</span>`;
    }

    tr.innerHTML = `<td>${esc(namn)}</td><td class="small">${esc([...mottagareSet].filter(Boolean).join(', '))}</td>
      <td class="split-cell">${entriesHtml}</td>`;
    tbody.appendChild(tr);

    // wire selects
    tr.querySelectorAll('.split-select').forEach((sel,i)=>{
      sel.value = entries[i].kundNr;
      sel.addEventListener('change', ()=>{
        entries[i].kundNr = sel.value;
        renderMappingTable();
      });
    });
    // wire percent inputs
    tr.querySelectorAll('.split-percent').forEach((inp,i)=>{
      inp.addEventListener('change', ()=>{
        entries[i].percent = parseFloat(inp.value)||0;
        renderMappingTable();
      });
    });
    // wire remove buttons
    tr.querySelectorAll('[data-remove]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const [nm, idx] = btn.dataset.remove.split('|');
        getMappingEntries(nm).splice(parseInt(idx),1);
        if(getMappingEntries(nm).length===0) getMappingEntries(nm).push({kundNr:'', percent:100});
        renderMappingTable();
      });
    });
    // wire add-split button
    tr.querySelector('[data-addsplit]').addEventListener('click', ()=>{
      const e = getMappingEntries(namn);
      // when going from 1->2 entries, rebalance evenly as a sane default
      if(e.length===1) e[0].percent = 50;
      e.push({kundNr:'', percent: e.length===1 ? 50 : Math.floor(100/(e.length+1))});
      renderMappingTable();
    });
  });
  if(shown===0){
    tbody.innerHTML = '<tr><td colspan="3" class="empty">Alla namn är mappade.</td></tr>';
  }
}
document.getElementById('mapping-unmapped-only').addEventListener('change', renderMappingTable);

// ---------- exclusion periods (ej fakturering) ----------
function getExclusionPeriods(namn){
  if(!state.exclusions[namn]) state.exclusions[namn] = [];
  return state.exclusions[namn];
}
function renderExclusionsTable(){
  const tbody = document.querySelector('#tbl-exclusions tbody');
  tbody.innerHTML = '';
  const namnSet = new Set(allUnderlagRows().map(r=>r.namn).filter(Boolean));
  if(namnSet.size===0){
    tbody.innerHTML = '<tr><td colspan="2" class="empty">Läs in underlag först.</td></tr>';
    return;
  }
  [...namnSet].sort((a,b)=>a.localeCompare(b,'sv')).forEach(namn=>{
    const periods = getExclusionPeriods(namn);
    const tr = document.createElement('tr');
    let rowsHtml = periods.map((p, i)=>`
      <div class="period-row">
        <input type="text" class="period-month period-from" data-namn="${esc(namn)}" data-idx="${i}" value="${esc(p.from)}" placeholder="2026-03">
        <span class="period-arrow">till</span>
        <input type="text" class="period-month period-to" data-namn="${esc(namn)}" data-idx="${i}" value="${esc(p.to)}" placeholder="pågående">
        <input type="text" class="period-comment" data-namn="${esc(namn)}" data-idx="${i}" value="${esc(p.comment)}" placeholder="kommentar, t.ex. flyttat">
        <button class="pill-btn" data-removeperiod="${esc(namn)}|${i}" title="Ta bort period">✕</button>
      </div>`).join('');
    rowsHtml += `<button class="period-add" data-addperiod="${esc(namn)}">+ lägg till period</button>`;
    tr.innerHTML = `<td>${esc(namn)}</td><td>${rowsHtml}</td>`;
    tbody.appendChild(tr);

    tr.querySelectorAll('.period-from').forEach((inp,i)=>{
      inp.addEventListener('change', ()=>{ periods[i].from = inp.value.trim(); });
    });
    tr.querySelectorAll('.period-to').forEach((inp,i)=>{
      inp.addEventListener('change', ()=>{ periods[i].to = inp.value.trim(); });
    });
    tr.querySelectorAll('.period-comment').forEach((inp,i)=>{
      inp.addEventListener('change', ()=>{ periods[i].comment = inp.value; });
    });
    tr.querySelectorAll('[data-removeperiod]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const [nm, idx] = btn.dataset.removeperiod.split('|');
        getExclusionPeriods(nm).splice(parseInt(idx),1);
        renderExclusionsTable();
      });
    });
    tr.querySelector('[data-addperiod]').addEventListener('click', ()=>{
      getExclusionPeriods(namn).push({from:'', to:'', comment:''});
      renderExclusionsTable();
    });
  });
}
// returns the matching exclusion period for a row, or null
function findExclusionForRow(row){
  const periods = state.exclusions[row.namn];
  if(!periods || periods.length===0) return null;
  const rowKey = monthKeyFromUnderlag(row.manad);
  for(const p of periods){
    if(!p.from) continue;
    const fromKey = monthKeyFromUnderlag(p.from);
    const toKey = p.to ? monthKeyFromUnderlag(p.to) : null;
    if(rowKey >= fromKey && (!toKey || rowKey <= toKey)) return p;
  }
  return null;
}

// ---------- matching / report ----------
document.getElementById('run-match').addEventListener('click', runMatch);
['filter-deviations','filter-outstanding','filter-hide-ok-months'].forEach(id=>{
  document.getElementById(id).addEventListener('change', ()=>{
    // kör bara om ifall en rapport redan visas
    if(document.getElementById('report').innerHTML.trim()) runMatch();
  });
});

function runMatch(){
  state.invoiceOffset = parseInt(document.getElementById('invoice-offset').value, 10) || 0;
  state.startUnderlag = document.getElementById('start-underlag').value.trim();
  state.startReskontra = document.getElementById('start-reskontra').value.trim();
  const filterDeviations = document.getElementById('filter-deviations').checked;
  const filterOutstanding = document.getElementById('filter-outstanding').checked;
  const filterHideOkMonths = document.getElementById('filter-hide-ok-months').checked;
  let shownKunder = 0;
  const startUnderlagKey = state.startUnderlag ? monthKeyFromUnderlag(state.startUnderlag) : null;
  const startReskontraKey = state.startReskontra || null; // expects YYYY-MM-DD, compares lexicographically

  const allRows = allUnderlagRows();
  const excludedRows = [];
  let skippedUnderlagCount = 0;
  const rows = allRows.filter(r=>{
    if(startUnderlagKey && monthKeyFromUnderlag(r.manad) < startUnderlagKey){ skippedUnderlagCount++; return false; }
    const period = findExclusionForRow(r);
    if(period){ excludedRows.push({...r, comment: period.comment, periodFrom: period.from, periodTo: period.to}); return false; }
    return true;
  });
  const reportEl = document.getElementById('report');
  if(allRows.length===0 || allReskontraRows().length===0){
    reportEl.innerHTML = '<div class="empty">Läs in underlag och kundreskontralista, och mappa minst en person, innan avstämning körs.</div>';
    return;
  }
  // group underlag by mapped kundNr -> faktureringsmånad -> sum avgift (split across mapped targets by percent)
  // faktureringsmånad = avser-månad förskjuten bakåt med invoiceOffset, så den går att jämföra
  // mot fakturadatumets kalendermånad i kundreskontralistan.
  const underlagByKund = new Map();
  const unmapped = [];
  rows.forEach(r=>{
    const entries = (getMappingEntries(r.namn) || []).filter(e=>e.kundNr);
    if(entries.length===0){ unmapped.push(r); return; }
    const serviceMk = monthKeyFromUnderlag(r.manad);
    const mk = shiftMonthKey(serviceMk, -state.invoiceOffset);
    entries.forEach(entry=>{
      const share = r.avgift * ((Number(entry.percent)||0) / 100);
      if(!underlagByKund.has(entry.kundNr)) underlagByKund.set(entry.kundNr, new Map());
      const monthMap = underlagByKund.get(entry.kundNr);
      monthMap.set(mk, (monthMap.get(mk)||0) + share);
    });
  });

  // group kundreskontralista by kundNr -> monthKey -> {debet, kredit}
  // Fakturarader grupperas på FAKTURADATUM (fallback verifikationsdatum), så Fakturerat hamnar i
  // fakturans månad även om den bokförts en annan dag; övriga rader på verifikationsdatum.
  const ledgerByKund = new Map();
  let skippedLedgerCount = 0;
  allReskontraRows().forEach(t=>{
    if(!t.kundNr) return;
    if(startReskontraKey && t.datum < startReskontraKey){ skippedLedgerCount++; return; }
    const mk = monthKeyFromDate(rowMonthDate(t));
    if(!ledgerByKund.has(t.kundNr)) ledgerByKund.set(t.kundNr, new Map());
    const monthMap = ledgerByKund.get(t.kundNr);
    const cur = monthMap.get(mk) || {debet:0, kredit:0};
    cur.debet += t.debet; cur.kredit += t.kredit;
    monthMap.set(mk, cur);
  });

  const identities = ledgerIdentities();
  let html = '';

  const allKunder = new Set([...underlagByKund.keys(), ...ledgerByKund.keys()]);
  if(allKunder.size===0){
    html += '<div class="empty">Ingen mappad person hittades — gå till avsnitt 4 och mappa namn.</div>';
  }

  [...allKunder].sort().forEach(kundNr=>{
    const kundNamn = identities.get(kundNr) || '(okänd)';
    const uMap = underlagByKund.get(kundNr) || new Map();
    const lMap = ledgerByKund.get(kundNr) || new Map();
    const allMonths = new Set([...uMap.keys(), ...lMap.keys()]);
    let custTotalUnderlag=0, custTotalDebet=0;

    // fakturor och betalningar kopplas ihop via exakt fakturanummer — inte kalendermånad,
    // eftersom betalningar ofta lander en annan månad än fakturan utan att det betyder något.
    // OBS: samma startdatum-filter som månadsvyn, annars blir totalsummorna inkonsekventa
    // (t.ex. en betalning räknas men inte dess faktura).
    const custReskontraRows = allReskontraRows().filter(t=>
      t.kundNr===kundNr && !(startReskontraKey && t.datum < startReskontraKey));
    // Flera debetrader med samma fakturanummer (t.ex. faktura + korrigering) summeras till EN
    // faktura, så fakturavyn och Fakturerat alltid bygger på samma belopp.
    const invoices = new Map(); // fakturanr -> {datum, belopp, rader}
    custReskontraRows.forEach(t=>{
      if(t.debet===0 || !t.fakturanr) return;
      const d = rowMonthDate(t);
      const cur = invoices.get(t.fakturanr);
      if(!cur){ invoices.set(t.fakturanr, {datum:d, belopp:t.debet, rader:1}); return; }
      cur.belopp += t.debet; cur.rader++;
      if(d < cur.datum) cur.datum = d;
    });
    const paymentsByInvoice = new Map(); // fakturanr -> {paid, lastDatum}
    // kredit-rader som inte kan kopplas till en faktura i perioden: saknar fakturanummer, eller
    // pekar på ett nummer som inte finns bland kundens fakturor (före startdatum, feltolkat, annan kund)
    const unmatchedPayments = [];
    custReskontraRows.forEach(t=>{
      if(t.kredit<=0) return;
      const nr = effectiveFakturanr(t);
      if(!nr){ unmatchedPayments.push({t, reason:'Inget fakturanummer i beskrivningen'}); return; }
      if(!invoices.has(nr)){ unmatchedPayments.push({t, reason:`Fakturanr ${nr} finns inte bland kundens fakturor i perioden`}); return; }
      const cur = paymentsByInvoice.get(nr) || {paid:0, lastDatum:''};
      cur.paid += t.kredit;
      if(t.datum > cur.lastDatum) cur.lastDatum = t.datum;
      paymentsByInvoice.set(nr, cur);
    });
    // kvittningar: positiv kvittningsrad = fakturan som regleras av en kredit,
    // negativ = kreditfakturan som förbrukas
    const creditAppliedByInvoice = new Map(); // fakturanr -> summa krediterat
    const creditConsumed = new Map(); // kreditens fakturanr -> förbrukat belopp
    custReskontraRows.forEach(t=>{
      if(t.typ!=='kvittning' || !t.fakturanr) return;
      if(t.kvittningsBelopp > 0){
        creditAppliedByInvoice.set(t.fakturanr, (creditAppliedByInvoice.get(t.fakturanr)||0) + t.kvittningsBelopp);
      } else if(t.kvittningsBelopp < 0){
        creditConsumed.set(t.fakturanr, (creditConsumed.get(t.fakturanr)||0) + (-t.kvittningsBelopp));
      }
    });
    // reglerat belopp per faktura i fakturans eget tecken: betalt + kvittad kredit för en faktura,
    // −förbrukat för en kreditfaktura. Rest = belopp − reglerat, för båda.
    const settledFor = (nr, inv)=> inv.belopp < 0
      ? -(creditConsumed.get(nr) || 0)
      : (paymentsByInvoice.get(nr)?.paid || 0) + (creditAppliedByInvoice.get(nr) || 0);
    // fakturor per månad (fakturans tidigaste fakturadatum) — varje faktura räknas i exakt en månad
    const invoicesByMonth = new Map();
    invoices.forEach((inv, nr)=>{
      const mk = monthKeyFromDate(inv.datum);
      if(!invoicesByMonth.has(mk)) invoicesByMonth.set(mk, []);
      invoicesByMonth.get(mk).push(nr);
      allMonths.add(mk);
    });

    let custHtml = '';
    let hasDeviation = false;
    let hiddenOkMonths = 0;
    let monthRowsHtml = '';

    [...allMonths].sort().forEach(mk=>{
      const underlagSum = uMap.get(mk) || 0;
      const led = lMap.get(mk) || {debet:0, kredit:0};
      const monthFakturanr = (invoicesByMonth.get(mk) || []).sort((a,b)=>a.localeCompare(b,'sv',{numeric:true}));
      const fakturanrList = monthFakturanr.join(', ');
      const diffUF = led.debet - underlagSum;
      custTotalUnderlag += underlagSum; custTotalDebet += led.debet;

      // regleringsstatus för just de fakturor som utfärdades denna månad, matchat på fakturanummer
      const monthBelopp = monthFakturanr.reduce((s,nr)=>s + invoices.get(nr).belopp, 0);
      const monthSettled = monthFakturanr.reduce((s,nr)=>s + settledFor(nr, invoices.get(nr)), 0);

      const okUF = Math.abs(diffUF) < 1;
      const approveKey = `${kundNr}|${mk}`;
      const approved = !!state.approvedDiffs[approveKey];
      if(!okUF && !approved) hasDeviation = true;
      const rowClass = (!okUF && !approved) ? 'warn' : '';
      const statusUF = approved
        ? '<span class="tag approved">Godkänd</span>'
        : (okUF ? '<span class="tag ok">Stämmer</span>' : `<span class="tag warn">Avviker ${diffUF>0?'+':''}${fmtNum(diffUF)}</span>`);

      const statusBetalning = monthFakturanr.length===0 ? '' : settleStatusTag(monthBelopp, monthSettled);

      if(filterHideOkMonths && (okUF || approved)){ hiddenOkMonths++; return; }

      monthRowsHtml += `<tr class="${rowClass}"><td>${esc(mk)||'—'}</td>
        <td>${esc(fakturanrList)}</td>
        <td class="num">${fmtNum(underlagSum)}</td>
        <td class="num">${fmtNum(led.debet)}</td>
        <td class="num ${okUF||approved?'diff-zero':'diff-pos'}">${fmtNum(diffUF)}</td>
        <td>${statusUF}</td>
        <td><input type="checkbox" class="approve-check" data-key="${esc(approveKey)}" ${approved?'checked':''}></td>
        <td class="num">${monthFakturanr.length ? fmtNum(monthSettled) : ''}</td>
        <td>${statusBetalning}</td></tr>`;
    });

    // Totalt-radens Reglerat/Utestående räknas på samma fakturamatchade grund som varje rad ovan
    // (inte råa kalendermånadssummor), så de två går att jämföra rakt av.
    let custTotalReglerat = 0;
    invoices.forEach((inv, nr)=>{ custTotalReglerat += settledFor(nr, inv); });
    const utestaende = custTotalDebet - custTotalReglerat;
    const totalDiffUF = custTotalDebet - custTotalUnderlag;
    const hasOutstanding = Math.abs(utestaende) >= 1;

    // globala filter — hoppa hela kunden om den inte matchar
    if(filterDeviations && !hasDeviation) return;
    if(filterOutstanding && !hasOutstanding) return;
    shownKunder++;

    custHtml += `<table style="margin-bottom:0;"><thead>
      <tr><th>Faktureringsmånad</th><th>Fakturanr</th><th class="num">Underlag</th><th class="num">Fakturerat</th>
      <th class="num">Diff U/F</th><th>Status U/F</th><th>Godkänd</th>
      <th class="num" title="Inbetalningar + kvittade krediter, kopplade på fakturanummer">Reglerat</th><th>Status betalning</th></tr></thead><tbody>`;
    custHtml += monthRowsHtml;
    if(hiddenOkMonths){
      custHtml += `<tr><td colspan="9" class="small" style="font-style:italic;padding:8px 10px;">${hiddenOkMonths} månad(er) som stämmer är dolda av filtret.</td></tr>`;
    }
    custHtml += `<tr class="group-head"><td>Totalt</td><td></td>
      <td class="num">${fmtNum(custTotalUnderlag)}</td>
      <td class="num">${fmtNum(custTotalDebet)}</td>
      <td class="num">${fmtNum(totalDiffUF)}</td>
      <td></td><td></td>
      <td class="num">${fmtNum(custTotalReglerat)}</td>
      <td>Utestående: ${fmtNum(utestaende)}</td></tr>`;
    custHtml += `</tbody></table>`;

    // detaljerad per-faktura-vy (samma underliggande matchning, en rad per faktura)
    if(invoices.size){
      custHtml += `<details class="excl-group"><summary>
          <span class="excl-namn">Fakturor per faktura</span>
          <span class="excl-meta">${invoices.size} st · exakt regleringsstatus (betalningar + kvittade krediter) oberoende av kalendermånad</span>
        </summary>
        <table><thead><tr><th>Fakturanr</th><th>Fakturadatum</th><th class="num">Belopp</th>
        <th class="num">Krediterat</th><th class="num">Betalt</th><th>Betaldatum</th><th>Status</th></tr></thead><tbody>`;
      [...invoices.entries()].sort((a,b)=>a[1].datum.localeCompare(b[1].datum)).forEach(([nr, inv])=>{
        const pay = paymentsByInvoice.get(nr) || {paid:0, lastDatum:''};
        const credited = creditAppliedByInvoice.get(nr) || 0;
        const isCredit = inv.belopp < 0;
        const status = settleStatusTag(inv.belopp, settledFor(nr, inv), {creditOnly: !isCredit && credited>0 && pay.paid===0});
        const raderNote = inv.rader>1 ? ` <span class="small">(${inv.rader} rader)</span>` : '';
        custHtml += `<tr><td>${esc(nr)}${raderNote}</td><td>${esc(inv.datum)}</td><td class="num">${fmtNum(inv.belopp)}</td>
          <td class="num">${isCredit ? fmtNum(creditConsumed.get(nr)||0) : (credited?fmtNum(credited):'')}</td>
          <td class="num">${isCredit ? '' : fmtNum(pay.paid)}</td><td>${esc(pay.lastDatum)}</td><td>${status}</td></tr>`;
      });
      custHtml += `</tbody></table></details>`;
    }

    // inbetalningar som inte kunnat kopplas till en faktura i perioden — låt användaren koppla manuellt
    if(unmatchedPayments.length){
      custHtml += `<details class="excl-group" open><summary>
          <span class="excl-namn">Ej matchade betalningar</span>
          <span class="excl-meta">${unmatchedPayments.length} st · räknas inte som reglerade — koppla manuellt, eller uteslut raden under "Alla transaktioner"</span>
        </summary>
        <table><thead><tr><th>Vernr</th><th>Datum</th><th>Beskrivning</th><th class="num">Belopp</th><th>Orsak</th><th>Koppla till faktura</th></tr></thead><tbody>`;
      unmatchedPayments.sort((a,b)=>a.t.datum.localeCompare(b.t.datum)).forEach(({t, reason})=>{
        const current = state.paymentOverrides[t.id] || '';
        const invoiceOptions = [...invoices.keys()].sort((a,b)=>a.localeCompare(b,'sv',{numeric:true}))
          .map(nr=>`<option value="${esc(nr)}" ${nr===current?'selected':''}>${esc(nr)}</option>`).join('');
        custHtml += `<tr><td>${esc(t.vernr)}</td><td>${esc(t.datum)}</td><td>${esc(t.beskrivning)}</td><td class="num">${fmtNum(t.kredit)}</td>
          <td class="small">${esc(reason)}</td>
          <td><select class="payment-override" data-id="${esc(t.id)}">
            <option value="">— välj faktura —</option>
            ${invoiceOptions}
          </select></td></tr>`;
      });
      custHtml += `</tbody></table></details>`;
    }

    // rå transaktionslogg — allt som lästs in för kunden, för granskning och möjlighet att
    // manuellt utesluta enskilda rader (t.ex. dubbelbokförda korrigeringsrader)
    // Löpande saldo = ackumulerat (debet − kredit) i datumordning (vernr som tiebreak).
    // Räknas bara på rader som ingår i avstämningen (ej uteslutna, ej före startdatum), så
    // slutsaldot är direkt jämförbart med Fakturerat − alla inbetalningar för kunden.
    // Kvittningsrader har debet=kredit=0 och lämnar saldot orört.
    const rawRowsForKund = allReskontraRowsRaw().filter(t=>t.kundNr===kundNr);
    let slutsaldo = 0;
    if(rawRowsForKund.length){
      let txHtml = '';
      rawRowsForKund
        .sort((a,b)=>a.datum.localeCompare(b.datum) || String(a.vernr).localeCompare(String(b.vernr), 'sv', {numeric:true}))
        .forEach(t=>{
          const excluded = !!state.excludedReskontraRows[t.id];
          const beforeStart = !!(startReskontraKey && t.datum < startReskontraKey);
          const inScope = !excluded && !beforeStart;
          if(inScope) slutsaldo += t.debet - t.kredit;
          const saldoCell = inScope ? fmtNum(slutsaldo) : '—';
          const notes = [
            t.note ? `<span class="tag cross">${esc(t.note)}</span>` : '',
            beforeStart ? '<span class="tag unmapped">Före startdatum</span>' : ''
          ].join('');
          txHtml += `<tr class="${excluded?'excluded-row':(beforeStart?'muted-row':'')}">
            <td><input type="checkbox" class="row-exclude" data-id="${esc(t.id)}" ${excluded?'checked':''}></td>
            <td>${esc(t.vernr)}</td><td>${esc(t.datum)}</td><td>${esc(t.typ)}</td><td>${esc(t.beskrivning)}</td>
            <td class="num">${fmtNum(t.debet)}</td><td class="num">${fmtNum(t.kredit)}</td>
            <td class="num saldo">${saldoCell}</td>
            <td>${esc(effectiveFakturanr(t))}</td>
            <td>${notes}</td></tr>`;
        });
      custHtml += `<details class="excl-group"><summary>
          <span class="excl-namn">Alla transaktioner (granska)</span>
          <span class="excl-meta">${rawRowsForKund.length} rad(er) · slutsaldo ${fmtNum(slutsaldo)} · kryssa för att utesluta en rad ur alla summeringar</span>
        </summary>
        <table><thead><tr><th>Uteslut</th><th>Vernr</th><th>Datum</th><th>Typ</th><th>Beskrivning</th>
        <th class="num">Debet</th><th class="num">Kredit</th><th class="num">Saldo</th><th>Fakturanr</th><th>Anmärkning</th></tr></thead><tbody>
        ${txHtml}
        <tr class="group-head"><td colspan="7">Slutsaldo</td><td class="num saldo">${fmtNum(slutsaldo)}</td><td colspan="2"></td></tr>
        </tbody></table></details>`;
    }
// sammanfattande badges i rubriken + kollapsbar kundgrupp
    const ufBadge = Math.abs(totalDiffUF) < 1
      ? (hasDeviation ? '<span class="tag warn">Månadsavvikelser</span>' : '<span class="tag ok">U/F stämmer</span>')
      : `<span class="tag warn">Diff U/F ${totalDiffUF>0?'+':''}${fmtNum(totalDiffUF)}</span>`;
    const utBadge = hasOutstanding
      ? `<span class="tag pay-warn">Utestående ${fmtNum(utestaende)}</span>`
      : '<span class="tag ok">Inget utestående</span>';
    // Saldo (debet − ALLA inbetalningar) ska normalt vara lika med Utestående (debet − reglerat på
    // fakturanummer). Skiljer de sig finns inbetalningar som inte kopplats till en faktura i perioden
    // (se "Ej matchade betalningar") eller kvittningsrader som inte går jämnt ut.
    const saldoMismatch = Math.abs(slutsaldo - utestaende) >= 1;
    const saldoBadge = saldoMismatch
      ? `<span class="tag warn" title="Slutsaldo i reskontran skiljer sig från Utestående — det finns inbetalningar som inte är kopplade till en faktura i perioden">Saldo ${fmtNum(slutsaldo)} ≠ utestående</span>`
      : '';
    const openAttr = (hasDeviation || hasOutstanding || saldoMismatch) ? ' open' : '';
    html += `<details class="excl-group kund-group"${openAttr}><summary>
        <span class="excl-namn">Kund ${esc(kundNr)} — ${esc(kundNamn)}</span>
        <span class="kund-badges">${ufBadge}${utBadge}${saldoBadge}</span>
      </summary><div style="padding:0 6px 10px;">${custHtml}</div></details>`;
  });

  if(allKunder.size>0 && shownKunder===0){
    html += '<div class="empty">Inga kunder matchar de valda filtren.</div>';
  }

  if(unmapped.length){
    const names = [...new Set(unmapped.map(r=>r.namn))];
    html += `<div class="small" style="margin-top:6px;"><span class="tag unmapped">Ej mappade</span> ${esc(names.join(', '))} — gå till avsnitt 4 för att koppla dessa.</div>`;
  }

  if(excludedRows.length){
    const byNamn = new Map();
    excludedRows.forEach(r=>{
      if(!byNamn.has(r.namn)) byNamn.set(r.namn, []);
      byNamn.get(r.namn).push(r);
    });
    html += `<div class="excl-group-wrap"><h3 class="excl-group-title">Ej fakturerade rader (uteslutna från avstämningen)</h3>`;
    [...byNamn.entries()].sort((a,b)=>a[0].localeCompare(b[0],'sv')).forEach(([namn, list])=>{
      const total = list.reduce((s,r)=>s+r.avgift,0);
      html += `<details class="excl-group"><summary>
          <span class="excl-namn">${esc(namn)}</span>
          <span class="excl-meta">${list.length} rad(er) · ${fmtNum(total)} kr</span>
        </summary>
        <table><thead><tr><th>Månad</th><th class="num">Avgift</th><th>Kommentar</th></tr></thead><tbody>`;
      list.sort((a,b)=>(a.manad||'').localeCompare(b.manad||''));
      list.forEach(r=>{
        html += `<tr><td>${esc(monthKeyFromUnderlag(r.manad))}</td><td class="num">${fmtNum(r.avgift)}</td><td>${esc(r.comment)}</td></tr>`;
      });
      html += `</tbody></table></details>`;
    });
    html += `</div>`;
  }

  if(skippedUnderlagCount || skippedLedgerCount){
    html += `<div class="small" style="margin-top:10px;">Ignorerat pga startdatum: ${skippedUnderlagCount} underlagsrad(er), ${skippedLedgerCount} reskontratransaktion(er).</div>`;
  }

  reportEl.innerHTML = html;
  reportEl.querySelectorAll('.approve-check').forEach(chk=>{
    chk.addEventListener('change', ()=>{
      if(chk.checked) state.approvedDiffs[chk.dataset.key] = true;
      else delete state.approvedDiffs[chk.dataset.key];
      runMatch();
    });
  });
  reportEl.querySelectorAll('.payment-override').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      if(sel.value) state.paymentOverrides[sel.dataset.id] = sel.value;
      else delete state.paymentOverrides[sel.dataset.id];
      runMatch();
    });
  });
  reportEl.querySelectorAll('.row-exclude').forEach(chk=>{
    chk.addEventListener('change', ()=>{
      if(chk.checked) state.excludedReskontraRows[chk.dataset.id] = true;
      else delete state.excludedReskontraRows[chk.dataset.id];
      runMatch();
    });
  });
}

// ---------- export / import state ----------
document.getElementById('export-state').addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'avstamning-state.json';
  a.click();
});
document.getElementById('import-state-btn').addEventListener('click', ()=>{
  document.getElementById('import-state').click();
});
document.getElementById('import-state').addEventListener('change', e=>{
  const file = e.target.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const loaded = JSON.parse(reader.result);
      // support both new (underlagFiles) and old (single underlag array) export formats
      if(loaded.underlagFiles) state.underlagFiles = loaded.underlagFiles;
      else if(loaded.underlag) state.underlagFiles = [{name:'importerad-fil.csv', rows: loaded.underlag}];
      else state.underlagFiles = [];
      state.manual = loaded.manual || [];
      state.reskontraFiles = loaded.reskontraFiles || [];
      state.manualIdentities = loaded.manualIdentities || {};
      state.birthYears = loaded.birthYears || {};
      state.paymentOverrides = loaded.paymentOverrides || {};
      migratePaymentOverrides();
      state.excludedReskontraRows = loaded.excludedReskontraRows || {};
      state.mapping = loaded.mapping || {};
      state.exclusions = loaded.exclusions || {};
      state.approvedDiffs = loaded.approvedDiffs || {};
      state.invoiceOffset = (loaded.invoiceOffset !== undefined) ? loaded.invoiceOffset : 1;
      state.startUnderlag = loaded.startUnderlag || '';
      state.startReskontra = loaded.startReskontra || loaded.startLedger || '';
      document.getElementById('invoice-offset').value = state.invoiceOffset;
      document.getElementById('start-underlag').value = state.startUnderlag;
      document.getElementById('start-reskontra').value = state.startReskontra;
      renderUnderlagFileList();
      renderReskontraFileList();
      renderManualKundList();
      renderUnderlagTable();
  renderBirthYearTable();
      renderMappingTable();
  renderExclusionsTable();
      runMatch();
    }catch(err){
      alert('Kunde inte läsa filen: '+err.message);
    }
  };
  reader.readAsText(file, 'utf-8');
});

renderUnderlagFileList();
renderReskontraFileList();
renderManualKundList();
renderUnderlagTable();
  renderBirthYearTable();
renderMappingTable();
  renderExclusionsTable();
