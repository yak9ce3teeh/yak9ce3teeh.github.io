(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const rows = [...document.querySelectorAll('.paper')];
  const groups = [...document.querySelectorAll('.topic-group')];
  const topics = [...new Set(rows.map(row => row.dataset.topic))].sort((a,b) => a.localeCompare(b));
  const controls = {search:$('search'),area:$('area-select'),topic:$('topic-select'),year:$('year-select'),notes:$('notes-select'),code:$('code-select'),keyword:$('keyword-select'),sort:$('sort-select'),group:$('group-toggle')};
  let area = '';
  const numeric = value => value === '' || value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  function dateOrder(a,b,direction=-1) {
    const ay=numeric(a.dataset.year), by=numeric(b.dataset.year);
    if(ay===null && by!==null) return 1;
    if(ay!==null && by===null) return -1;
    if(ay!==by) return direction*(ay-by);
    const am=numeric(a.dataset.month), bm=numeric(b.dataset.month);
    if(am===null && bm!==null) return 1;
    if(am!==null && bm===null) return -1;
    return am!==bm ? direction*(am-bm) : 0;
  }
  function metricOrder(a,b,name) {
    const av=numeric(a.dataset[name]), bv=numeric(b.dataset[name]);
    if(av===null && bv!==null) return 1;
    if(av!==null && bv===null) return -1;
    return av===bv ? 0 : bv-av;
  }
  function compare(a,b) {
    let order=0;
    switch(controls.sort.value) {
      case 'code': order=Number(b.dataset.available==='yes')-Number(a.dataset.available==='yes');break;
      case 'stars': order=metricOrder(a,b,'stars');break;
      case 'citations': order=metricOrder(a,b,'citations');break;
      case 'oldest': order=dateOrder(a,b,1);break;
      case 'newest': order=dateOrder(a,b,-1);break;
      case 'title': return a.dataset.title.localeCompare(b.dataset.title) || Number(a.dataset.id)-Number(b.dataset.id);
    }
    return order || dateOrder(a,b,-1) || a.dataset.title.localeCompare(b.dataset.title) || Number(a.dataset.id)-Number(b.dataset.id);
  }
  function render() {
    const words=controls.search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const code=controls.code.value;
    let count=0;
    rows.forEach(row => {
      const d=row.dataset;
      const codeMatch=!code || (code==='available' ? d.available==='yes' : d.code===code);
      const keywordMatch=!controls.keyword.value || d.keywords.split('|').includes(controls.keyword.value);
      const yearMatch=!controls.year.value || (controls.year.value==='unknown' ? !d.year : d.year===controls.year.value);
      row.hidden=!((!area || d.area===area) && (!controls.topic.value || d.topic===controls.topic.value) && yearMatch && (!controls.notes.value || d.notes===controls.notes.value) && codeMatch && keywordMatch && words.every(word => d.search.includes(word)));
      if(!row.hidden) count++;
      row.querySelectorAll('.keyword-chip').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.keyword===controls.keyword.value)));
    });
    const sorted=[...rows].sort(compare);
    document.documentElement.classList.toggle('grouped',controls.group.checked);
    $('sort-label').textContent=controls.group.checked ? 'Sort within topics' : 'Sort by';
    $('flat-list').hidden=controls.group.checked;
    $('topic-groups').hidden=!controls.group.checked;
    if(controls.group.checked) {
      const lists=new Map(groups.map(group=>[group.dataset.topic,group.querySelector('.paper-list')]));
      sorted.forEach(row=>lists.get(row.dataset.topic).appendChild(row));
      groups.forEach(group=>{
        const count=[...group.querySelectorAll('.paper')].filter(row=>!row.hidden).length;
        group.hidden=count===0;group.querySelector('.group-count').textContent=String(count);
      });
    } else {
      sorted.forEach(row=>$('flat-list').appendChild(row));
    }
    $('result-count').replaceChildren('Showing ',Object.assign(document.createElement('strong'),{textContent:String(count)}),count===rows.length?' files':` of ${rows.length} files`);
    $('empty-state').hidden=count!==0;
  }
  function setArea(value) {
    area=value;controls.area.value=value;
    document.querySelectorAll('.area-button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.area===value)));
    controls.topic.replaceChildren(new Option('All topics',''));
    topics.filter(topic=>!area || topic.split('/')[0]===area).forEach(topic=>controls.topic.add(new Option(area?topic.split('/').slice(1).join('/'):topic,topic)));
    render();
  }
  function clearFilters() {
    controls.search.value='';controls.year.value='';controls.notes.value='';controls.code.value='';controls.keyword.value='';setArea('');
  }
  document.querySelectorAll('.area-button').forEach(button=>button.addEventListener('click',()=>setArea(button.dataset.area)));
  document.querySelectorAll('.keyword-chip').forEach(button=>button.addEventListener('click',()=>{controls.keyword.value=button.dataset.keyword;render();}));
  controls.area.addEventListener('change',()=>setArea(controls.area.value));
  controls.search.addEventListener('input',render);
  [controls.topic,controls.year,controls.notes,controls.code,controls.keyword,controls.sort,controls.group].forEach(control=>control.addEventListener('change',render));
  $('clear-filters').addEventListener('click',clearFilters);
  $('clear-empty').addEventListener('click',()=>{clearFilters();controls.search.focus();});
  render();
  document.documentElement.classList.add('enhanced');
})();
