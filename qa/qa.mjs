// npm run build && npm run qa
// Drives the full flow (run, crash at the gate, edit, reject, approve, crash mid-retry, tabs, session 2, reset)
// at every viewport, checks each state, and writes screenshots plus one contact sheet per group to qa/shots/.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p) => p && existsSync(p));
const PORT = 4180;
const URL = `http://localhost:${PORT}/crm-agent-harness-demo/`;
const OUT = resolve('qa/shots');
const VIEWPORTS = [
  ['320x568', 'phones', 320, 568], ['360x740', 'phones', 360, 740], ['390x844', 'phones', 390, 844], ['412x915', 'phones', 412, 915],
  ['352x780', 'phones', 352, 780], ['352x780-text115', 'phones', 352, 780, 1.15], ['352x780-text130', 'phones', 352, 780, 1.3],
  ['1280x800', 'desktop', 1280, 800], ['1440x900', 'desktop', 1440, 900], ['1920x1080', 'desktop', 1920, 1080],
].map(([id, group, w, h, text = 1]) => ({ id, group, w, h, text }))
  .filter((v) => !process.env.QA_VIEWPORTS || process.env.QA_VIEWPORTS.split(',').includes(v.id));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, ['scripts/serve.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
for (let i = 0; i < 50; i++) { try { if ((await fetch(URL)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 100)); }

// Runs in the page: layout problems a phone user would notice.
function audit(textScale) {
  const issues = [];
  const vw = window.innerWidth;
  if (document.documentElement.scrollWidth > vw + 1) issues.push(`horizontal overflow ${document.documentElement.scrollWidth}px > ${vw}px`);
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'; };
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 && !el.closest('pre')) issues.push(`extends past viewport: <${el.tagName.toLowerCase()} class="${el.className}"> right=${Math.round(r.right)}`);
    if (cs.overflowX !== 'visible' && el.scrollWidth > el.clientWidth + 1) issues.push(`clipped horizontally: <${el.tagName.toLowerCase()} class="${el.className}">`);
    if (el.childNodes.length && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && parseFloat(cs.fontSize) < 12.5 * textScale) issues.push(`small text ${cs.fontSize}: "${el.textContent.trim().slice(0, 30)}"`);
  }
  for (const el of document.querySelectorAll('button, select, input, textarea, summary')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 43.5) issues.push(`tap target ${Math.round(r.height)}px tall: "${(el.textContent || el.id).trim().slice(0, 30)}"`);
  }
  const body = parseFloat(getComputedStyle(document.body).fontSize);
  if (body < 16 * textScale - 0.1) issues.push(`body font ${body}px`);
  return [...new Set(issues)].slice(0, 12);
}

const report = [];
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
for (const vp of VIEWPORTS) {
  const phone = vp.group === 'phones';
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(URL);
  if (vp.text !== 1) await page.addStyleTag({ content: `html { font-size: ${vp.text * 100}% !important; }` });
  const state = () => page.locator('#states li.current').innerText();
  const waitState = (s) => page.waitForFunction((x) => document.querySelector('#states li.current')?.textContent?.trim() === x, s, { timeout: 45000 });
  const tab = async (t) => { if (phone || t !== 'timeline') await page.click(`#tabs [data-tab="${t}"]`); };
  const show = async (sel, last = false) => {
    await page.evaluate(([s, l]) => { const els = document.querySelectorAll(s); const el = l ? els[els.length - 1] : els[0]; el?.scrollIntoView({ block: 'start' }); }, [sel, last]);
    await page.waitForTimeout(250);
  };
  const shot = async (name, notes = []) => {
    const file = `${vp.id}__${name}.png`;
    await page.screenshot({ path: `${OUT}/${file}` });
    const issues = [...(await page.evaluate(audit, vp.text)), ...errors.splice(0), ...notes];
    report.push({ viewport: vp.id, group: vp.group, state: name, file, issues });
  };

  await shot('01-initial');
  await page.click('.controls [data-act="run"]');
  await page.waitForTimeout(2600);
  const partial = await page.evaluate(() => document.querySelectorAll('[data-panel="timeline"] .step').length);
  await shot('01b-paced', partial > 1 && partial < 8 ? [] : [`FLOW: pacing not visible (${partial} steps after 2.6 s)`]);
  await waitState('Awaiting approval');
  await show('.gate');
  await shot('02-gate');

  await page.click('.gate [data-act="crash"]');
  await page.waitForSelector('text=Simulated crash, then recovery');
  await show('.step.info', true);
  await shot('03-recovered-at-gate', (await state()) === 'Awaiting approval' ? [] : ['FLOW: not parked after recovery']);

  const cards = page.locator('.gate .approval');
  await cards.nth(0).locator('[data-act="edit"]').click();
  await page.click('[data-act="example-edit"]');
  await show('.gate .approval');
  await shot('04-edit-form');
  await page.click('[data-act="save-edit"]');

  await cards.nth(1).locator('[data-act="reject"]').click();
  await cards.nth(1).locator('textarea').fill('Legal asked us to pause outreach until Friday');
  await cards.nth(1).locator('textarea').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(200);
  await shot('05-reject-form');
  await cards.nth(1).locator('[data-act="confirm-reject"]').click();

  await cards.nth(2).locator('[data-act="approve"]').click();
  await page.waitForSelector('text=Retrying in', { timeout: 30000 });
  const backoff = await page.locator('.waiting').count();
  await page.click('.controls [data-act="crash"]');
  await page.waitForSelector('text=Sent exactly once', { timeout: 10000 });
  await show('.step.exec');
  const crashedMidRetry = await page.locator('text=Crash here.').count();
  await shot('06-retry-and-crash', [...(crashedMidRetry ? [] : ['FLOW: crash did not land inside the retry window']), ...(backoff ? [] : ['FLOW: backoff wait not shown'])]);
  await page.click('.controls [data-act="skip"]');
  const skipped = await page.waitForFunction(() => document.querySelector('#states li.current')?.textContent?.trim() === 'Completed', null, { timeout: 4000 }).then(() => true, () => false);
  if (!skipped) report.at(-1).issues.push('FLOW: Skip ahead did not finish the run quickly');

  await waitState('Completed');
  await page.waitForTimeout(400);
  const summary = await page.locator('.step', { hasText: "Here's where things stand" }).count();
  await show('.step', true);
  await page.evaluate(() => window.scrollBy(0, -window.innerHeight * 0.55));
  await page.waitForTimeout(200);
  await shot('07-completed', summary ? [] : ['FLOW: no final summary']);

  for (const [t, name] of [['crm', '08-crm'], ['memo', '09-memo'], ['audit', '10-audit']]) {
    await tab(t);
    await show(phone ? '.sticky' : '.layout');
    await shot(name);
  }
  const outbox = await page.evaluate(() => document.querySelectorAll('[data-panel="crm"] .row').length);

  await tab('timeline');
  if (phone) await page.click('#tabs [data-tab="timeline"]');
  await page.click('[data-act="session2"]');
  await page.waitForSelector('text=Going from the task memo', { timeout: 20000 });
  await waitState('Completed');
  await show('.step', true);
  await page.evaluate(() => window.scrollBy(0, -window.innerHeight * 0.3));
  await page.waitForTimeout(200);
  await shot('11-session2');

  await page.click('.controls [data-act="reset"]');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  const cleared = await page.evaluate(() => !document.querySelector('#states li.current') && !document.querySelector('.gate'));
  await shot('12-reset', cleared ? [] : ['FLOW: reset did not clear the run']);
  if (!outbox) report.at(-1).issues.push('FLOW: CRM panel empty');
  await ctx.close();
  console.log(`${vp.id}: ${report.filter((r) => r.viewport === vp.id && r.issues.length).length} shots with issues`);
}

// Contact sheets: rows = viewports, columns = states.
for (const group of ['phones', 'desktop']) {
  const rows = VIEWPORTS.filter((v) => v.group === group);
  const states = [...new Set(report.map((r) => r.state))];
  const w = group === 'phones' ? 190 : 330;
  const cell = (r) => `<td><div class="st">${r.state}</div><img src="${r.file}"><div class="${r.issues.length ? 'bad' : 'ok'}">${r.issues.length ? r.issues.map((i) => i.replace(/</g, '&lt;')).join('<br>') : 'ok'}</div></td>`;
  const html = `<html><body style="font:12px system-ui;margin:8px;background:#eee"><table>${rows.map((v) => `<tr><th>${v.id}</th>${states.map((s) => cell(report.find((r) => r.viewport === v.id && r.state === s))).join('')}</tr>`).join('')}</table>
    <style>td{vertical-align:top;background:#fff;padding:6px;width:${w}px}img{width:${w}px;border:1px solid #bbb}th{writing-mode:vertical-rl;transform:rotate(180deg)}.st{font-weight:700;margin-bottom:4px}.bad{color:#b00;margin-top:4px}.ok{color:#176b3a;margin-top:4px}</style></body></html>`;
  writeFileSync(`${OUT}/sheet-${group}.html`, html);
  const p = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await p.goto(`file:///${OUT.replace(/\\/g, '/')}/sheet-${group}.html`);
  await p.screenshot({ path: `${OUT}/contact-sheet-${group}.png`, fullPage: true });
  await p.close();
}
await browser.close();
server.kill();

writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
const failed = report.filter((r) => r.issues.length);
for (const f of failed) console.log(`FAIL ${f.viewport} ${f.state}: ${f.issues.join(' | ')}`);
console.log(`\n${report.length - failed.length}/${report.length} states passed. Sheets: qa/shots/contact-sheet-phones.png, qa/shots/contact-sheet-desktop.png`);
process.exit(failed.length ? 1 : 0);
