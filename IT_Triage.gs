/**
 * IT REQUEST TRIAGE AUTOMATION
 * Google Apps Script, bound to the IT request spreadsheet.
 *
 * Requirements, testing, and deployment: PurpleFlagg
 * Code written with AI assistance (Claude)
 *
 * What it does:
 *   1. Copies each new form submission into an "Active Queue" tab
 *   2. Color-codes requests by priority (Urgent = red) and sorts urgent work to the top
 *   3. Flags duplicates: same individual + same issue type, both still open
 *   4. Flags stalled requests with a bell (24 hrs if Urgent, 7 days otherwise)
 *      and emails one reminder to the IT mailbox
 *   5. Moves resolved requests to the "Resolved" tab for records
 *
 * Setup: paste into Extensions > Apps Script, update IT_MAILBOX below,
 * then run setup() once. Run importOpenRequests() once to bring in existing open requests.
 */

// ==================== SETTINGS (safe to edit) ====================
const CONFIG = {
  IT_MAILBOX: 'your-it-mailbox@example.org',   // <-- change to your shared IT mailbox
  URGENT_HOURS: 24,                            // reminder after this many hours for Urgent
  STANDARD_HOURS: 24 * 7,                      // reminder after 7 days for everything else

  FORM_TAB: 'Form Responses',
  QUEUE_TAB: 'Active Queue',
  ARCHIVE_TAB: 'Resolved',

  // The start of each form question's title (capital letters don't matter)
  QUESTIONS: {
    timestamp: 'Timestamp',
    email: 'Email Address',
    name: "Individual's full name",
    issue: 'Issue type',
    priority: 'What priority level',
    location: 'If for an individual',
    troubleshooting: 'What troubleshooting steps',
    notes: 'Notes',                     // agents' notes on the form
    // Old columns, used only by importOpenRequests()
    legacyRequest: 'What is the nature of your request',
    legacyStatus: 'Status',
    legacyNotes: 'IT Notes (old)'        // old manual notes column, renamed before go-live
  },

  PRIORITIES: ['Urgent', 'High', 'Medium', 'Low'],
  STATUSES: ['New', 'Seen', 'In Progress', 'On Hold', 'Resolved'],
  STALE_STATUSES: ['New', 'Seen', 'In Progress'],   // On Hold is never flagged
  NO_DUPLICATE_CHECK: ['Other']                       // issue types too broad to match
};
// =================================================================

const QUEUE_HEADERS = [
  'Request ID', 'Submitted', 'Individual', 'Location', 'Issue Type', 'Priority',
  'Notes', 'Troubleshooting', 'Submitted By', 'Status', 'Additional Notes',
  'Last Status Change', 'Days Open', 'Flags'
];
const ARCHIVE_HEADERS = QUEUE_HEADERS.concat(['Date Resolved', 'Resolved By', 'Days to Resolve']);
const BELL = '🔔';

function col_(name) { return QUEUE_HEADERS.indexOf(name) + 1; }

// ---------- One-time setup ----------
function setup() {
  const ss = SpreadsheetApp.getActive();
  checkSheetIsReady_(ss);
  const queue = getOrCreateSheet_(ss, CONFIG.QUEUE_TAB, QUEUE_HEADERS);
  const archive = getOrCreateSheet_(ss, CONFIG.ARCHIVE_TAB, ARCHIVE_HEADERS);
  formatQueue_(queue);
  formatArchive_(archive);

  // Remove old copies of our triggers, then install fresh ones.
  // Installable triggers run with the owner's permissions, whoever makes the edit.
  const ours = ['onTriageFormSubmit', 'onTriageEdit', 'checkStaleRequests'];
  ScriptApp.getProjectTriggers().forEach(t => {
    if (ours.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onTriageFormSubmit').forSpreadsheet(ss).onFormSubmit().create();
  ScriptApp.newTrigger('onTriageEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('checkStaleRequests').timeBased().everyHours(1).create();

  ss.toast('Setup complete. Refresh the sheet to see the IT Triage menu.', 'IT Triage', 10);
}

// Stops setup with a clear message if a step in the guide was skipped
function checkSheetIsReady_(ss) {
  const form = ss.getSheetByName(CONFIG.FORM_TAB);
  if (!form) throw new Error('No tab named "' + CONFIG.FORM_TAB + '" was found.');
  const headers = form.getRange(1, 1, 1, form.getLastColumn()).getValues()[0];
  const notesCols = headers.filter(h => String(h).trim().toLowerCase() === 'notes').length;
  if (notesCols > 1) throw new Error('Form Responses has two "Notes" columns. ' +
    'Rename the old manual one to "IT Notes (old)" (see the setup guide), then run setup again.');
  const archive = ss.getSheetByName(CONFIG.ARCHIVE_TAB);
  if (archive && archive.getLastRow() > 0 &&
      String(archive.getRange(1, 1).getValue()) !== ARCHIVE_HEADERS[0]) {
    throw new Error('A "' + CONFIG.ARCHIVE_TAB + '" tab already exists with other data. ' +
      'Rename it to "Resolved (old)" (see the setup guide), then run setup again.');
  }
}

// ---------- New form submission ----------
function onTriageFormSubmit(e) {
  const formSheet = e.range.getSheet();
  if (formSheet.getName() !== CONFIG.FORM_TAB) return;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const headers = formSheet.getRange(1, 1, 1, formSheet.getLastColumn()).getValues()[0];
    const row = formSheet.getRange(e.range.getRow(), 1, 1, headers.length).getValues()[0];
    const val = key => {
      const i = findCol_(headers, CONFIG.QUESTIONS[key]);
      return i >= 0 ? row[i] : '';
    };

    const queue = SpreadsheetApp.getActive().getSheetByName(CONFIG.QUEUE_TAB);
    const id = nextId_();
    const submitted = val('timestamp') instanceof Date ? val('timestamp') : new Date();
    const record = {
      'Request ID': id,
      'Submitted': submitted,
      'Individual': cleanName_(val('name')),
      'Location': val('location'),
      'Issue Type': String(val('issue')).trim(),
      'Priority': normalizePriority_(val('priority')),
      'Notes': val('notes'),
      'Troubleshooting': val('troubleshooting'),
      'Submitted By': val('email'),
      'Status': 'New',
      'Additional Notes': '',
      'Last Status Change': submitted,
      'Days Open': 0,
      'Flags': ''
    };

    // Duplicate check: same individual + same issue type, both unresolved.
    // Everything in the Active Queue is unresolved, so only the queue is checked.
    const dupIds = findDuplicates_(queue, record['Individual'], record['Issue Type']);
    if (dupIds.length) {
      record['Flags'] = '⚠️ Duplicate of ' + dupIds.join(', ');
      dupIds.forEach(d => addFlagById_(queue, d, '⚠️ Repeat request: ' + id));
    }

    queue.appendRow(QUEUE_HEADERS.map(h => record[h]));
    sortQueue_(queue);
  } finally {
    lock.releaseLock();
  }
}

// ---------- Edits in the Active Queue ----------
function onTriageEdit(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== CONFIG.QUEUE_TAB) return;
  if (e.range.getRow() < 2 || e.range.getNumRows() > 1 || e.range.getNumColumns() > 1) return;
  if (e.range.getColumn() !== col_('Status')) return;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const row = e.range.getRow();
    const status = String(e.value || '').trim();
    sheet.getRange(row, col_('Last Status Change')).setValue(new Date());
    removeBell_(sheet, row);   // any status change counts as follow-up
    if (status === 'Resolved') archiveRow_(sheet, row, editorEmail_(e));
  } finally {
    lock.releaseLock();
  }
}

// ---------- Hourly stale-request check ----------
function checkStaleRequests() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const ss = SpreadsheetApp.getActive();
    const sheet = ss.getSheetByName(CONFIG.QUEUE_TAB);
    const n = sheet.getLastRow() - 1;
    if (n < 1) return;

    const data = sheet.getRange(2, 1, n, QUEUE_HEADERS.length).getValues();
    const I = name => col_(name) - 1;
    const now = new Date();
    const days = [], flags = [], newlyStale = [];

    data.forEach(r => {
      const submitted = r[I('Submitted')];
      const daysOpen = submitted instanceof Date ? Math.floor((now - submitted) / 864e5) : r[I('Days Open')];
      const last = r[I('Last Status Change')] instanceof Date ? r[I('Last Status Change')] : submitted;
      const limit = r[I('Priority')] === 'Urgent' ? CONFIG.URGENT_HOURS : CONFIG.STANDARD_HOURS;
      const status = r[I('Status')] || 'New';
      let f = String(r[I('Flags')] || '');

      const stale = CONFIG.STALE_STATUSES.indexOf(status) >= 0 &&
        last instanceof Date && (now - last) / 36e5 >= limit;
      if (stale && f.indexOf(BELL) < 0) {
        f = BELL + ' Needs follow-up' + (f ? ' | ' + f : '');
        newlyStale.push({ r: r, daysOpen: daysOpen });
      }
      days.push([daysOpen]);
      flags.push([f]);
    });

    // Write back only these two columns so teammates' notes are never overwritten
    sheet.getRange(2, col_('Days Open'), n, 1).setValues(days);
    sheet.getRange(2, col_('Flags'), n, 1).setValues(flags);

    if (newlyStale.length && CONFIG.IT_MAILBOX.indexOf('example.org') < 0) {
      // Email lists request IDs only, no names: details stay in the sheet
      const lines = newlyStale.map(x =>
        x.r[I('Request ID')] + '  |  ' + x.r[I('Priority')] + '  |  ' +
        (x.r[I('Issue Type')] || 'No issue type') + '  |  Status: ' + (x.r[I('Status')] || 'New') +
        '  |  Open ' + x.daysOpen + ' day(s)');
      MailApp.sendEmail({
        to: CONFIG.IT_MAILBOX,
        subject: BELL + ' ' + newlyStale.length + ' IT request(s) need follow-up',
        body: 'These requests have not moved forward within their time limit:\n\n' +
          lines.join('\n') + '\n\nOpen the Active Queue: ' + ss.getUrl()
      });
    }
  } finally {
    lock.releaseLock();
  }
}

// ---------- One-time import of requests that are already open ----------
function importOpenRequests() {
  const props = PropertiesService.getDocumentProperties();
  if (props.getProperty('importDone') === 'yes') {
    SpreadsheetApp.getActive().toast('Open requests were already imported.', 'IT Triage', 8);
    return;
  }
  const ss = SpreadsheetApp.getActive();
  const form = ss.getSheetByName(CONFIG.FORM_TAB);
  const queue = ss.getSheetByName(CONFIG.QUEUE_TAB);
  const values = form.getDataRange().getValues();
  const headers = values.shift();
  const Q = CONFIG.QUESTIONS;
  const at = (row, key) => { const i = findCol_(headers, Q[key]); return i >= 0 ? row[i] : ''; };
  const now = new Date();
  const out = [];

  values.forEach(row => {
    const ts = at(row, 'timestamp');
    if (!(ts instanceof Date)) return;                           // skip blank rows
    const oldStatus = String(at(row, 'legacyStatus')).trim();
    if (oldStatus === 'Resolved') return;                        // closed already
    // Old "nature of request" text moves into Notes (plus any new-form Notes)
    const text = [at(row, 'legacyRequest'), at(row, 'notes')].filter(String).join(' | ');
    out.push([
      nextId_(), ts, cleanName_(at(row, 'name')), at(row, 'location'), at(row, 'issue'),
      normalizePriority_(at(row, 'priority')), text, at(row, 'troubleshooting'), at(row, 'email'),
      CONFIG.STATUSES.indexOf(oldStatus) >= 0 ? oldStatus : 'New',
      at(row, 'legacyNotes'), now, Math.floor((now - ts) / 864e5), ''
    ]);
  });

  if (out.length) {
    queue.getRange(queue.getLastRow() + 1, 1, out.length, QUEUE_HEADERS.length).setValues(out);
    sortQueue_(queue);
  }
  props.setProperty('importDone', 'yes');
  ss.toast('Imported ' + out.length + ' open request(s).', 'IT Triage', 10);
}

// ---------- Menu ----------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('IT Triage')
    .addItem('Sort queue by priority', 'sortQueueFromMenu')
    .addItem('Check for stale requests now', 'checkStaleRequests')
    .addToUi();
}

function sortQueueFromMenu() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { sortQueue_(SpreadsheetApp.getActive().getSheetByName(CONFIG.QUEUE_TAB)); }
  finally { lock.releaseLock(); }
}

// ---------- Helpers ----------
function archiveRow_(sheet, row, who) {
  const archive = sheet.getParent().getSheetByName(CONFIG.ARCHIVE_TAB);
  const values = sheet.getRange(row, 1, 1, QUEUE_HEADERS.length).getValues()[0];
  const resolved = new Date();
  const submitted = values[col_('Submitted') - 1];
  const daysToResolve = submitted instanceof Date
    ? Math.round((resolved - submitted) / 864e5 * 10) / 10 : '';
  archive.appendRow(values.concat([resolved, who, daysToResolve]));
  sheet.deleteRow(row);
}

function sortQueue_(sheet) {
  const n = sheet.getLastRow() - 1;
  if (n < 2) return;
  const range = sheet.getRange(2, 1, n, QUEUE_HEADERS.length);
  const data = range.getValues();
  const p = col_('Priority') - 1, s = col_('Submitted') - 1;
  const rank = v => { const i = CONFIG.PRIORITIES.indexOf(v); return i < 0 ? 99 : i; };
  data.sort((a, b) => (rank(a[p]) - rank(b[p])) || (new Date(a[s]) - new Date(b[s])));
  range.setValues(data);   // urgent first, then oldest first within each priority
}

function findDuplicates_(queue, name, issue) {
  if (!name || !issue || CONFIG.NO_DUPLICATE_CHECK.indexOf(issue) >= 0) return [];
  const n = queue.getLastRow() - 1;
  if (n < 1) return [];
  const data = queue.getRange(2, 1, n, QUEUE_HEADERS.length).getValues();
  const key = s => cleanName_(s).toLowerCase();
  return data
    .filter(r => key(r[col_('Individual') - 1]) === key(name) &&
                 String(r[col_('Issue Type') - 1]).trim() === issue)
    .map(r => r[col_('Request ID') - 1]);
}

function addFlagById_(sheet, id, text) {
  const n = sheet.getLastRow() - 1;
  if (n < 1) return;
  const ids = sheet.getRange(2, 1, n, 1).getValues();
  for (let i = 0; i < n; i++) {
    if (ids[i][0] === id) {
      const cell = sheet.getRange(i + 2, col_('Flags'));
      const cur = String(cell.getValue() || '');
      if (cur.indexOf(text) < 0) cell.setValue(cur ? cur + ' | ' + text : text);
      return;
    }
  }
}

function removeBell_(sheet, row) {
  const cell = sheet.getRange(row, col_('Flags'));
  const parts = String(cell.getValue() || '').split(' | ').filter(x => x.indexOf(BELL) < 0);
  cell.setValue(parts.join(' | '));
}

function findCol_(headers, title) {
  const norm = s => String(s).replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  const t = norm(title);
  let i = headers.findIndex(h => norm(h) === t);          // exact match first
  if (i < 0) i = headers.findIndex(h => norm(h).indexOf(t) === 0);   // then "starts with"
  return i;
}

function cleanName_(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

function normalizePriority_(v) {
  const s = String(v || '').trim().toLowerCase();
  const match = CONFIG.PRIORITIES.filter(p => p.toLowerCase() === s)[0];
  return match || String(v || '').trim();
}

function nextId_() {
  const props = PropertiesService.getDocumentProperties();
  const n = Number(props.getProperty('lastId') || 0) + 1;
  props.setProperty('lastId', String(n));
  return 'REQ-' + ('0000' + n).slice(-4);
}

function editorEmail_(e) {
  return (e.user && e.user.getEmail()) || Session.getActiveUser().getEmail() || 'Unknown';
}

function getOrCreateSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setFontColor('#ffffff').setBackground('#5b3e96');
    sh.setFrozenRows(1);
  }
  return sh;
}

function formatQueue_(sh) {
  const last = sh.getMaxRows();
  const rows = last - 1;
  const C = c => sh.getRange(2, col_(c), rows, 1);

  C('Priority').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(CONFIG.PRIORITIES, true).setAllowInvalid(false).build());
  C('Status').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(CONFIG.STATUSES, true).setAllowInvalid(false).build());
  C('Submitted').setNumberFormat('m/d/yyyy h:mm am/pm');
  C('Last Status Change').setNumberFormat('m/d/yyyy h:mm am/pm');
  ['Notes', 'Additional Notes', 'Troubleshooting', 'Flags'].forEach(c => C(c).setWrap(true));
  sh.setColumnWidth(col_('Notes'), 280);
  sh.setColumnWidth(col_('Additional Notes'), 220);
  sh.setColumnWidth(col_('Troubleshooting'), 200);
  sh.setColumnWidth(col_('Flags'), 220);

  const all = sh.getRange(2, 1, rows, QUEUE_HEADERS.length);
  const L = c => String.fromCharCode(64 + col_(c));   // column letter
  const rule = (range, formula, bg, font, bold) => {
    const b = SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(formula)
      .setBackground(bg).setRanges([range]);
    if (font) b.setFontColor(font);
    if (bold) b.setBold(true);
    return b.build();
  };
  const P = '$' + L('Priority') + '2', S = '$' + L('Status') + '2', F = '$' + L('Flags') + '2';

  // Earlier rules win when two apply to the same cell
  sh.setConditionalFormatRules([
    rule(C('Flags'), '=ISNUMBER(SEARCH("' + BELL + '",' + F + '))', '#ffd54f', '#000000', true),
    rule(C('Flags'), '=ISNUMBER(SEARCH("Duplicate",' + F + '))+ISNUMBER(SEARCH("Repeat",' + F + '))', '#e1bee7', '#000000', true),
    rule(C('Priority'), '=' + P + '="Urgent"', '#c62828', '#ffffff', true),
    rule(C('Priority'), '=' + P + '="High"', '#ef6c00', '#ffffff', true),
    rule(C('Priority'), '=' + P + '="Medium"', '#fff59d'),
    rule(C('Priority'), '=' + P + '="Low"', '#c8e6c9'),
    rule(C('Status'), '=' + S + '="New"', '#d9d9d9'),
    rule(C('Status'), '=' + S + '="Seen"', '#ffe599'),
    rule(C('Status'), '=' + S + '="In Progress"', '#9fc5e8'),
    rule(C('Status'), '=' + S + '="On Hold"', '#cc0000', '#ffffff'),
    rule(all, '=' + P + '="Urgent"', '#fde0dc')   // whole urgent row tinted red
  ]);
}

function formatArchive_(sh) {
  const rows = sh.getMaxRows() - 1;
  const at = name => ARCHIVE_HEADERS.indexOf(name) + 1;
  ['Submitted', 'Last Status Change', 'Date Resolved'].forEach(c =>
    sh.getRange(2, at(c), rows, 1).setNumberFormat('m/d/yyyy h:mm am/pm'));
}
