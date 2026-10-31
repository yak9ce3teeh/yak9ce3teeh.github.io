"""Build a self-contained, source-backed research catalog with global ranking."""
from pathlib import Path
from collections import Counter
from datetime import datetime
import calendar
import html
import json
import re
from urllib.parse import quote

ROOT=Path(__file__).resolve().parent
LIBRARY=ROOT.parent
manifest=json.loads((LIBRARY/'Archive Manifest.json').read_text(encoding='utf-8'))
snapshot=json.loads((LIBRARY/'Paper Metadata.json').read_text(encoding='utf-8'))
metadata={row['file_id']:row for row in snapshot['records']}
LABELS={'open':'Open source','public':'Public code · license unclear / custom','restricted':'Restricted license','resources':'Survey resources','not_released':'Code not released','not_found':'Code not found','unverified':'Code unverified','not_applicable':'Reading-note export'}

def e(value):return html.escape(str(value),quote=True)
def url(value):return '/'.join(quote(part,safe='') for part in str(value).replace('\\','/').split('/'))
def anchor(address,label,cls='',external=False):
    return f'<a class="{cls}" href="{e(address if external else url(address))}" target="_blank" rel="noopener">{e(label)}<span class="sr-only"> (opens in a new tab)</span></a>'
def unknown(value):return '' if value is None else str(value)
def date_parts(row):
    date=row.get('publication_date') or ''
    return date[:4] if len(date)>=4 else '',date[5:7] if len(date)>=7 else ''
def date_key(row):
    y,m=date_parts(row)
    return (not bool(y),-int(y) if y else 0,not bool(m),-int(m) if m else 0)
def default_key(i):
    row=metadata[i];return (not row['code_available'],*date_key(row),(row['title'] or '').casefold(),i)
def date_html(row):
    year,month=date_parts(row)
    if month:return f'<time datetime="{e(row["publication_date"])}"><span class="month-name">{calendar.month_abbr[int(month)]}</span><span class="date-year">{e(year)}</span></time>'
    if year:return f'{e(year)}<span class="month-unknown">month unknown</span>'
    return '<span>Date<br>unknown</span>'

areas=sorted(Counter(row['category'].split('/')[0] for row in manifest).items())
topics=sorted(set(row['category'] for row in manifest))
keywords=sorted({tag for row in metadata.values() for tag in row['keywords']},key=str.casefold)
years=sorted({date_parts(row)[0] for row in metadata.values() if date_parts(row)[0]},reverse=True)
area_buttons=''.join(f'<button class="area-button" type="button" data-area="{e(area)}" aria-pressed="false"><span>{e(area)}</span><span class="area-count">{count}</span></button>' for area,count in areas)
options=lambda values:''.join(f'<option value="{e(value)}">{e(value)}</option>' for value in values)
area_options=''.join(f'<option value="{e(area)}">{e(area)} ({count})</option>' for area,count in areas)
groups=[]
for n,topic in enumerate(topics):
    groups.append(f'<section class="topic-group" data-topic="{e(topic)}" aria-labelledby="topic-{n}"><div class="topic-heading"><div><p class="area-label">{e(topic.split("/")[0])}</p><h2 id="topic-{n}">{e(topic.split("/",1)[1])} <span class="group-count">0</span></h2></div>{anchor(topic+"/Reading Notes Summary.html","Topic reading notes","summary-link")}</div><div class="paper-list"></div></section>')

rows=[]
for i in sorted(range(len(manifest)),key=default_key):
    item=manifest[i];meta=metadata[i];path=item['dest'].replace('\\','/');filename=path.rsplit('/',1)[-1]
    short=re.sub(r'^(?:\d{4}(?:-\d{2})?|Year Unknown)\s*-\s*','',filename[:-4])
    title=meta['title'] or item['title'] or short
    if re.match(r'^\d{4}\.\d+',short) or 'Overview' in short:short=title.split(':')[0]
    title=title.replace('$Ψ_0$','Ψ₀').replace('$NavA^3$','NavA³')
    if i==5:short='BFM-Zero'
    secondary=f'<p class="short-name">{e(short)}</p>' if short.casefold()!=title.casefold() else ''
    export='<span class="export-badge">Reading-note export</span>' if meta['kind']=='note_export' else ''
    year,month=date_parts(meta)
    search=' '.join([title,short,item['category'],filename,meta['publication_date'] or '',*meta['keywords']]).lower()
    code=meta['code_status'];tag=f'<span class="code-badge {e(code.replace("_","-"))}">{e(LABELS[code])}</span>'
    if meta['repository_kind']=='community':tag+='<span class="community-badge">Community implementation</span>'
    tag+=''.join(f'<button class="keyword-chip" type="button" data-keyword="{e(keyword)}" aria-pressed="false">{e(keyword)}</button>' for keyword in meta['keywords'])
    if meta['kind']=='note_export':metrics='<span class="metric-unknown">Code and citation metrics do not apply to reading-note exports.</span>'
    else:
        stars=meta['repository_stars'];citations=meta['citation_count']
        metrics=anchor(meta['repository_url'],f'{stars:,} stars',external=True) if stars is not None and meta['repository_url'] else '<span class="metric-unknown">Stars unknown</span>'
        if meta.get('stars_scope')=='monorepo':metrics='<span class="metric-unknown">Shared repository · stars not ranked</span>'
        metrics+=anchor(meta['citation_url'],f'{citations:,} citations',external=True) if citations is not None and meta['citation_url'] else '<span class="metric-unknown">Citations unknown</span>'
    reader_url=f'reader/?id={i}'
    actions=[anchor(reader_url,'Read paper','reader-button',external=True),anchor(path,'Open PDF','pdf-button')]
    if item['note']:actions.append(anchor(item['note'],'Reading notes','notes-link'))
    else:actions.append('<span class="unavailable">No linked reading notes</span>')
    if meta['repository_url']:
        label='Community code' if meta['repository_kind']=='community' else 'Resources' if meta['repository_kind']=='resources' else 'Code' if meta['code_available'] else 'Repository'
        actions.append(anchor(meta['repository_url'],label,'code-link',external=True))
    elif meta['code_project_url']:actions.append(anchor(meta['code_project_url'],'Project','project-link',external=True))
    if item['key']:actions.append(f'<a class="zotero-link" href="zotero://select/library/items/{e(item["key"])}">Open in Zotero</a>')
    date_source=anchor(meta['date_source'],'Source',external=True) if meta['date_source'] else anchor(path,'File')
    code_source=anchor(meta['code_source'],'Source',external=True) if meta['code_source'] else 'Not available'
    shared_stars=f"<p>Shared monorepo total: {meta['repository_total_stars']:,} stars. Excluded from paper-specific star ranking.</p>" if meta.get('stars_scope')=='monorepo' and meta.get('repository_total_stars') is not None else ''
    citation_source=anchor(meta['citation_url'],'Semantic Scholar',external=True) if meta['citation_url'] else 'Not available from Semantic Scholar' if meta['kind']=='paper' else 'Not applicable'
    checked=lambda value: e((value or 'Not checked')[:10])
    license_label=meta['repository_license'] or 'Unconfirmed' if meta['repository_url'] else 'Not applicable'
    details=f'''<details class="metadata-details"><summary>Details and sources</summary><dl>
    <dt>Date</dt><dd>{e(meta['publication_date'] or 'Unknown')} · {e(meta['date_basis'] or 'No verified date')} · {date_source}</dd>
    <dt>Code status</dt><dd>{e(LABELS[code])} · {code_source}</dd>
    <dt>Code license</dt><dd>{e(license_label)}</dd>
    <dt>Citations</dt><dd>{citation_source} · checked {checked(meta['citations_checked_at'])}</dd>
    <dt>Repository stars</dt><dd>{e(meta['repository'] or 'No verified repository')} · checked {checked(meta['stars_checked_at'])}</dd>
    <dt>Code checked</dt><dd>{checked(meta['code_checked_at'])}</dd>
    <dt>Topic notes</dt><dd>{anchor(item['category']+'/Reading Notes Summary.html','Topic reading notes')}</dd>
    </dl><p>{e(meta['code_note'])}</p>{shared_stars}{'<p>'+e(meta['license_note'])+'</p>' if meta['license_note'] else ''}</details>'''
    rows.append(f'''<article class="paper" data-id="{i}" data-area="{e(item['category'].split('/')[0])}" data-topic="{e(item['category'])}" data-year="{e(year)}" data-month="{e(month)}" data-notes="{'yes' if item['note'] else 'no'}" data-code="{e(code)}" data-available="{'yes' if meta['code_available'] else 'no'}" data-stars="{e(unknown(meta['repository_stars']))}" data-citations="{e(unknown(meta['citation_count']))}" data-keywords="{e('|'.join(meta['keywords']))}" data-title="{e(title.lower())}" data-search="{e(search)}">
      <div class="paper-year">{date_html(meta)}</div><div class="paper-body">{secondary}{export}<h3>{anchor(reader_url,title,'paper-title',external=True)}</h3><p class="paper-category">{e(item['category'].replace('/',' / '))}</p><div class="paper-tags">{tag}</div><div class="paper-metrics">{metrics}</div><div class="paper-actions">{' '.join(actions)}</div>{details}</div></article>''')

css=(ROOT/'base.css').read_text(encoding='utf-8')+'\n'+(ROOT/'catalog.css').read_text(encoding='utf-8')
template=(ROOT/'catalog.html').read_text(encoding='utf-8')
checked_date=datetime.fromisoformat(snapshot['checked_at']).strftime('%d %b %Y')
replacements={'__CSS__':css,'__JS__':(ROOT/'catalog.js').read_text(encoding='utf-8'),'__TOTAL__':str(len(manifest)),'__AREAS__':str(len(areas)),'__CODE_COUNT__':str(sum(row['code_available'] for row in metadata.values())),'__NOTES_COUNT__':str(sum(bool(row['note']) for row in manifest)),'__AREA_BUTTONS__':area_buttons,'__AREA_OPTIONS__':area_options,'__TOPIC_OPTIONS__':options(topics),'__YEAR_OPTIONS__':options(years),'__KEYWORD_OPTIONS__':options(keywords),'__ROWS__':''.join(rows),'__GROUPS__':''.join(groups),'__CHECKED_DATE__':checked_date,'__MONTH_COUNT__':str(sum(bool(date_parts(row)[1]) for row in metadata.values()))}
for token,value in replacements.items():template=template.replace(token,value)
(LIBRARY/'index.html').write_text(template,encoding='utf-8')
print(f'Built enriched catalog: {len(manifest)} files, {len(keywords)} keywords, {len(topics)} topics.')
