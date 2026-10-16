// --- GLOBAL CONFIGURATION ---
const CXALLOY_IDENTIFIER = 'gCqssIlWYq9ssNqdwcKMhEodt'; // e.g., 'XwQaC1ujqwyFUDo6WIGjXtw8l'
const CXALLOY_SECRET     = 'aV59a1p9AMbN5wITxbvKvDj3Vithj64LR4qWZ9zJwBvQrJRAf0yhY9PxNu';

function sendRequest(url = null, type = 'get', body = null) {
  var identifier = CXALLOY_IDENTIFIER;
  var secret     = CXALLOY_SECRET;

  // Generate signature
  var timestamp = Math.floor(new Date().getTime() / 1000).toString();
  var stringToSign = body ? JSON.stringify(body) + timestamp : timestamp;
  var signature = generateHmacSignature(stringToSign, secret);

  var options = {
    'method': type,
    'headers': {
      'cache-control': 'no-cache',
      'content-type': 'application/json',
      'cxalloy-identifier': identifier,
      'cxalloy-signature': signature,
      'cxalloy-timestamp': timestamp
    }
  };

  if (body && type !== 'GET') {
    options['payload'] = JSON.stringify(body);
  }

  try {
    var response = UrlFetchApp.fetch(url, options);
    var result = response.getContentText();
    return JSON.parse(result);
  } catch (e) {
    Logger.log('Error: ' + e.toString());
    return null;
  }
}

// Function to generate HMAC-SHA256 signature
function generateHmacSignature(string, secret) {
  var signature = Utilities.computeHmacSha256Signature(string, secret);
  return signature.map(function(byte) {
    var v = (byte < 0 ? byte + 256 : byte).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}


function createAllSpreadsheets() {
  // Define column headers for each sheet
  const projectColumns = ["project_id", "account_id", "name", "status", "number", "client", "building_owner", "location", "size", "cost", "phase", "timezone", "is_upgraded"];
  const equipmentColumns = ["equipment_id", "project_id", "name", "status_id", "description", "type_id", "type", "discipline_id", "discipline", "space_id", "space", "floor_id", "floor", "building_id", "building", "location", "status", "date_installed", "last_service_date"];
  const checklistColumns = ["checklist_id", "name", "description", "status", "assigned_to", "due_date", "date_completed"];
  const testColumns = ["test_id", "name", "description", "status", "assigned_to", "start_date", "end_date", "result"];
  const issueColumns = ["project_id",
    "issue_id", "name", "description", "asset_name", "asset_type", "section", "drawing", "priority_id", "priority",
    "due_date", "date_closed", "assigned_name", "assigned_type", "discipline_id", "discipline", "status_id", "status",
    "source_name", "source_type", "source_id", "created_by", "date_created", "asset_key", "assigned_key",
    "collaborators", "time_to_close_seconds", "extended_status", "open_date", "open_person", "in_progress_date",
    "in_progress_person", "pending_review_date", "pending_review_person", "closed_date", "closed_person", "comments",
    "created_name", "comment", "issuecomment_id", "comment_date_created", "fk_issue"
  ];

  // Create each spreadsheet
  createSpreadsheet("Projects", projectColumns);
  createSpreadsheet("Equipment", equipmentColumns);
  createSpreadsheet("Checklists", checklistColumns);
  createSpreadsheet("Tests", testColumns);
  createSpreadsheet("Issues", issueColumns);
}

function createSpreadsheet(sheetName, columns) {
  // Get the active spreadsheet
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

  // Check if the sheet already exists
  let sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    // If not, create a new sheet
    sheet = spreadsheet.insertSheet(sheetName);
  } else {
    // If it exists, clear it
    sheet.clear(); // Clear all contents
  }

  // Set the column headers
  sheet.getRange(1, 1, 1, columns.length).setValues([columns]);

  // Log the creation or update process
  Logger.log(`Sheet "${sheetName}" created or updated with columns: ${columns.join(", ")}`);
}

function fetchAndUpdateCxAlloyData() {

  // Fetch and log project data
  fetchAndUpdateProjectData();

  // Fetch and update equipment, checklist, test and issue data with pagination
  var projectId = 45; // Replace with ProjectID
  console.log(`Project ID: ${projectId}`)
  console.log("Equipment Data");
  fetchAndUpdateEquipmentData(projectId);
  console.log("Checklist Templates");
  fetchAndUpdateChecklistTemplates(projectId); // before Checklist Data, so the template_name join below has something to read
  console.log("Checklist Data");
  fetchAndUpdateChecklistData(projectId);
  console.log("Test Data");
  fetchAndUpdateTestData(projectId);
  console.log("Issue Data");
  fetchAndUpdateIssueData(projectId);
  ifareaserved();
  moveColumnData();
  combineColumnsWithPrefix();
  buildChecklistTypeMapping(); // append any newly-seen templates to the Checklist Type Mapping sheet, never touching rows already there
  generateChecklistMatrix();
}

// Fetches every checklist template defined for this project (not
// individual checklist instances — the reusable templates they're created
// from) via GET /checklisttemplate?project_id=X with no checklisttemplate_id,
// which per CxAlloy's docs returns the full list for the project.
function fetchAndUpdateChecklistTemplates(projectId = 45) {
  console.log("Fetching Checklist Template Data");
  var templateApiUrl = 'https://google.cxalloy.com/api/v1/checklisttemplate';
  var allTemplateData = fetchData(templateApiUrl + '?project_id=' + projectId);
  console.log("Updating Checklist Templates Sheet");
  populateSheetWithData('Checklist Templates', allTemplateData);
}

function fetchAndUpdateProjectData() {
  // Fetch Data
  console.log("Fetching Data");
  var projectApiUrl = 'https://google.cxalloy.com/api/v1/project';
  var projectData = fetchData(projectApiUrl);
  // Update sheet with Data
  console.log("Updating Data")
  populateSheetWithData('Projects', projectData);
}

function fetchAndUpdateEquipmentData(projectId = 45) {
  console.log("Fetching Data");
  var equipmentApiUrl = 'https://google.cxalloy.com/api/v1/equipment';
  var allEquipmentData = fetchPaginatedData(equipmentApiUrl + '?project_id=' + projectId + '&include=systems,zones,attributes,areas_served');
  // Update sheet with Data
  console.log("Updating Data")
  populateSheetWithData('Equipment', allEquipmentData);
}

function fetchAndUpdateAttributeData(projectId = 45) {
  console.log("Fetching Equipment Data");
  var equipmentApiUrl = 'https://google.cxalloy.com/api/v1/equipment';

  // We only need to include attributes now, so we can drop systems, zones, etc. from the URL
  var allEquipmentData = fetchPaginatedData(equipmentApiUrl + '?project_id=' + projectId + '&include=attributes');

  console.log("Modifying Equipment data to extract ONLY asset name and attributes");

  // 1. First Pass: Discover all unique custom Attributes across all equipment
  let attributeNames = new Set();
  allEquipmentData.forEach(eq => {
    if (eq.attributes && Array.isArray(eq.attributes)) {
      eq.attributes.forEach(attr => {
        if (attr.name) attributeNames.add(attr.name);
      });
    }
  });

  // Sort them so the columns appear alphabetically
  let dynamicHeaders = Array.from(attributeNames).sort();

  // 2. Second Pass: Build a fresh array containing ONLY the name and the attributes
  var simplifiedEquipmentData = [];

  for (var i = 0; i < allEquipmentData.length; i++) {
    var eq = allEquipmentData[i];

    // Create a new object with strictly the Asset Name
    var simplifiedEq = {
      "Asset Name": eq.name || ""
    };

    // Ensure every object has all attribute keys so Object.keys(data[0]) catches them all
    dynamicHeaders.forEach(header => {
       simplifiedEq[header] = "";
    });

    // Map the actual attribute values (and units) into those new keys
    if (eq.attributes && Array.isArray(eq.attributes)) {
      eq.attributes.forEach(attr => {
        let displayValue = attr.value || '';
        if (attr.unit && displayValue !== '') {
          displayValue += ' ' + attr.unit;
        }
        simplifiedEq[attr.name] = displayValue;
      });
    }

    // Push our clean, simplified object to the new array
    simplifiedEquipmentData.push(simplifiedEq);
  }

  // Update sheet with Data using our new simplified array
  console.log("Updating Equipment Data Sheet");
  populateSheetWithData('Attributes', simplifiedEquipmentData);
}

// One-off diagnostic — run this directly from the Apps Script editor
// (select it in the function dropdown, click Run, then View > Logs). It
// fetches a single raw /checklist record and logs every field name CxAlloy
// actually returns, so we can confirm (or correct) the assumption that
// the template foreign key is called "checklisttemplate_id".
function debugChecklistFields(projectId = 45) {
  var checklistApiUrl = 'https://google.cxalloy.com/api/v1/checklist';
  var requestBody = { 'project_id': projectId, 'page': 1, 'include': ['time_to_close', 'extended_status'] };
  var response = sendRequest(checklistApiUrl, 'post', requestBody);
  var records = (response && response.records) || [];
  if (records.length === 0) {
    Logger.log('No checklist records returned.');
    return;
  }
  Logger.log('Field names on a raw /checklist record: ' + Object.keys(records[0]).join(', '));
  Logger.log('Full first record: ' + JSON.stringify(records[0], null, 2));
}

function fetchAndUpdateChecklistData(projectId=45) {
  console.log("Fetching Data");
  var checklistApiUrl = 'https://google.cxalloy.com/api/v1/checklist';
  var allChecklistData = fetchPaginatedPostData(checklistApiUrl, projectId, ['time_to_close', 'extended_status']);
  // Modify checklist data to extract relevant fields from 'extended_status' as keys in allChecklistData
  console.log("Modifying Checklist data")
  for (var i = 0; i < allChecklistData.length; i++) {
    // Extract extended status from the row for unpacking
    var extended_status = allChecklistData[i]["extended_status"]
    // Unpack required fields from extended status to new columns in the row
    allChecklistData[i]["script_in_development_date"] = extended_status["script_in_development_date"];
    allChecklistData[i]["assigned_date"] = extended_status["assigned_date"];
    allChecklistData[i]["in_progress_date"] = extended_status["in_progress_date"];
    allChecklistData[i]["pre_-_energization_complete_date"] = extended_status["pre_-_energization_complete_date"];
    allChecklistData[i]["pre_-_energization_verified_date"] = extended_status["pre_-_energization_verified_date"];
    allChecklistData[i]["checklist_complete_date"] = extended_status["checklist_complete_date"];
    allChecklistData[i]["verified_date"] = extended_status["verified_date"];
    allChecklistData[i]["verified_-_not_included_in_sampling_date"] = extended_status["verified_-_not_included_in_sampling_date"];
    // Delete extended_status
    delete allChecklistData[i]["extended_status"]
  }

  // Attach each checklist's template name, joined via its template_id
  // against the already-populated "Checklist Templates" sheet — confirmed
  // against a real /checklist record: the FK field is "template_id"
  // (e.g. "17475"), not "checklisttemplate_id".
  console.log("Joining template names onto Checklist data")
  var templateNameById = getChecklistTemplateNameMap_();
  for (var j = 0; j < allChecklistData.length; j++) {
    var tplId = allChecklistData[j]["template_id"];
    allChecklistData[j]["template_name"] = (tplId !== undefined && tplId !== null && templateNameById[tplId]) ? templateNameById[tplId] : "";
  }

  // Update sheet with Data
  console.log("Updating Data")
  populateSheetWithData('Checklists', allChecklistData);
}

// Reads the "Checklist Templates" sheet into a { template_id: name }
// lookup map, used to join a template name onto each Checklists row. The
// Checklists sheet's own FK field is confirmed to be "template_id" (from
// a raw /checklist record); the template's own PK field name on
// /checklisttemplate records hasn't been directly confirmed, so this
// tries the most likely candidates in order.
function getChecklistTemplateNameMap_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Checklist Templates');
  var map = {};
  if (!sheet) return map;
  var data = sheet.getDataRange().getValues();
  if (data.length < 2) return map;
  var headers = data[0].map(function(h) { return String(h).toLowerCase().trim(); });
  var idIdx = headers.indexOf('template_id');
  if (idIdx === -1) idIdx = headers.indexOf('checklisttemplate_id');
  if (idIdx === -1) idIdx = headers.indexOf('id');
  var nameIdx = headers.indexOf('name');
  if (idIdx === -1 || nameIdx === -1) return map;
  for (var i = 1; i < data.length; i++) {
    var id = data[i][idIdx];
    if (id !== '' && id !== undefined && id !== null) map[id] = data[i][nameIdx];
  }
  return map;
}

// Shared by readAssetMatrix_() and readChecklistTypeMapping_() — both
// sheets use the identical layout: row 1 = merged Level 2/3/4 phase
// labels (only the first cell of each merge populated), row 2 = the
// per-column type label (Tag, Elec, NETA, ...). Returns the type columns
// found: [{ col (0-based), phase, label }].
function parseMatrixTypeColumns_(sheet) {
  const data = sheet.getDataRange().getDisplayValues();
  if (data.length < 2) return [];
  const phaseRow = data[0];
  const typeRow = data[1];
  const colPhase = [];
  let currentPhase = '';
  for (let c = 0; c < phaseRow.length; c++) {
    const raw = String(phaseRow[c] || '').trim();
    const m = raw.match(/level\s*(\d)/i);
    if (m) currentPhase = 'L' + m[1];
    colPhase.push(currentPhase);
  }
  const typeCols = [];
  for (let c = 1; c < typeRow.length; c++) {
    const label = String(typeRow[c] || '').trim();
    const phase = colPhase[c];
    if (label && phase) typeCols.push({ col: c, phase: phase, label: label });
  }
  return typeCols;
}

// Detects an explicit phase marker in a checklist template's own name.
// "LN" ("L2", "L3") is the Level N verification phase and maps straight
// to the matching Asset Matrix phase. "iN" ("i2", "i3") is a DIFFERENT,
// separate marker — confirmed NOT the same thing as Level 2/3 — so it's
// kept as its own distinct token ("I2", "I3") rather than being folded
// into "L2"/"L3". Since the Asset Matrix only defines Level 2/3/4
// columns today, an i2/i3-marked template has no phase to match against
// and is intentionally left unmapped (no column, no guessing) rather
// than leaking into the Level 2/3 columns.
function detectTemplatePhaseMarker_(name) {
  const m = name.match(/\b([il])(\d)\b/i);
  if (!m) return null;
  return (m[1].toLowerCase() === 'i' ? 'I' : 'L') + m[2];
}

// Normalizes a label/segment for comparison — lowercase, strip everything
// but letters/digits, so "Elec - Other" and "elec-other" and "ELEC OTHER"
// all collapse to the same key.
function normalizeTypeToken_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Picks the single best type-label match for a template name, scoped to
// one phase's columns. Template names are dash-delimited, e.g.
// "L2 - gCUB 4.1 - ACC - Controls - Checklist - V1.0": the phase marker
// and trailing version are stripped first, then each remaining dash
// segment ("gCUB 4.1", "ACC", "Controls", "Checklist") is checked against
// that phase's column labels as a WHOLE SEGMENT (exact or prefix match in
// either direction) — never as a substring of the raw, unsplit name. That
// isolation is what keeps "gCUB" from matching the "GC" column and
// "Mechanical" from double-matching "Mech" everywhere it appears. Plain
// "Checklist" is the generic catch-all suffix nearly every template ends
// with, so it's only used if nothing more specific matched. Returns at
// most one label, or null.
function matchTemplateTypeForPhase_(name, phaseTypeCols) {
  let working = name.replace(/^\s*[il]\d\s*-\s*/i, '');
  working = working.replace(/-\s*v?\d+(\.\d+)*\s*$/i, '').trim();
  const segments = working.split(/\s*-\s*/).map(s => s.trim()).filter(Boolean);
  const segNorms = segments.map(normalizeTypeToken_).filter(Boolean);
  const labelNorms = phaseTypeCols.map(tc => ({ tc: tc, norm: normalizeTypeToken_(tc.label) }));
  // How much extra text a prefix match is allowed to carry beyond the
  // label itself — enough slack for "Mechanical"/"Mech" and
  // "Electrical"/"Elec" (6-char gaps), not enough for an asset name that
  // merely happens to start with a label word, e.g. "Fire Suppression Wet
  // Zone" vs the "Fire" column (19-char gap) — that must NOT match.
  const MAX_PREFIX_SLACK = 6;

  // Pass 1: an exact segment==label match is unambiguous — take it before
  // trying any prefix match, so e.g. a literal "Elec" segment always wins
  // the "Elec" column over the "Elec - Other" column it also prefixes.
  for (const segNorm of segNorms) {
    for (const entry of labelNorms) {
      if (entry.norm && entry.norm !== 'checklist' && segNorm === entry.norm) return entry.tc;
    }
  }
  // Pass 2: close prefix match either direction — skipped for labels
  // under 4 characters (e.g. "GC"), since a short label is too likely to
  // prefix-match an unrelated word by coincidence.
  for (const segNorm of segNorms) {
    for (const entry of labelNorms) {
      const norm = entry.norm;
      if (!norm || norm === 'checklist' || norm.length < 4) continue;
      if (segNorm.startsWith(norm) && segNorm.length - norm.length <= MAX_PREFIX_SLACK) return entry.tc;
      if (norm.startsWith(segNorm) && segNorm.length >= 4 && norm.length - segNorm.length <= MAX_PREFIX_SLACK) return entry.tc;
    }
  }
  // Pass 3: fall back to the generic "Checklist" column, if this phase has
  // one and a segment literally says "Checklist" — nothing more specific
  // matched.
  for (const segNorm of segNorms) {
    for (const entry of labelNorms) {
      if (entry.norm === 'checklist' && segNorm === 'checklist') return entry.tc;
    }
  }
  return null;
}

// Keeps the "Checklist Type Mapping" sheet in sync with whatever templates
// currently exist, laid out exactly like "Asset Matrix" (its header rows
// are copied verbatim, merged cells included, so the two sheets can never
// structurally drift apart) — row 1/2 = the same Level 2/3/4 phase groups
// and type-label columns, column A = template name, 'x' marks per row
// instead of an asset's requirements. Existing rows are NEVER touched —
// only templates not yet represented get a new row — so any manual
// correction (adding/removing an 'x') survives every future re-run.
function buildChecklistTypeMapping() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const templatesSheet = ss.getSheetByName('Checklist Templates');
  const assetMatrixSheet = ss.getSheetByName('Asset Matrix');
  if (!templatesSheet) {
    SpreadsheetApp.getUi().alert("The 'Checklist Templates' sheet is missing — run fetchAndUpdateChecklistTemplates() first.");
    return;
  }
  if (!assetMatrixSheet) {
    SpreadsheetApp.getUi().alert("The 'Asset Matrix' sheet is missing — it's used as the header template for 'Checklist Type Mapping'.");
    return;
  }
  const templateData = templatesSheet.getDataRange().getValues();
  if (templateData.length < 2) return;
  const tHeaders = templateData[0].map(h => String(h).toLowerCase().trim());
  const nameIdx = tHeaders.indexOf('name');
  if (nameIdx === -1) return;
  const distinctNames = Array.from(new Set(templateData.slice(1).map(r => String(r[nameIdx] || '').trim()).filter(Boolean)));

  let mapSheet = ss.getSheetByName('Checklist Type Mapping');
  if (!mapSheet) mapSheet = ss.insertSheet('Checklist Type Mapping');

  // Copy Asset Matrix's own header rows (values + merges + formatting)
  // verbatim the first time, so the column layout is guaranteed identical.
  if (mapSheet.getLastRow() < 2) {
    const width = assetMatrixSheet.getLastColumn();
    assetMatrixSheet.getRange(1, 1, 2, width).copyTo(mapSheet.getRange(1, 1, 2, width));
    mapSheet.getRange(1, 1).setValue('Template Name');
  }

  const typeCols = parseMatrixTypeColumns_(mapSheet);
  const width = mapSheet.getLastColumn();

  const existingData = mapSheet.getDataRange().getValues();
  const existingNames = new Set();
  if (existingData.length > 2) {
    existingData.slice(2).forEach(r => { const n = String(r[0] || '').trim(); if (n) existingNames.add(n); });
  }

  const colsByPhase = {};
  typeCols.forEach(tc => {
    if (!colsByPhase[tc.phase]) colsByPhase[tc.phase] = [];
    colsByPhase[tc.phase].push(tc);
  });
  const allPhases = Object.keys(colsByPhase);

  const newRows = [];
  distinctNames.forEach(name => {
    if (existingNames.has(name)) return; // already in the sheet — leave it exactly as it is, even if blank
    const forcedPhase = detectTemplatePhaseMarker_(name);
    const phasesToTry = forcedPhase ? [forcedPhase] : allPhases; // the name itself says which phase — don't guess at the others when it does
    const row = new Array(width).fill('');
    row[0] = name;
    phasesToTry.forEach(phase => {
      const match = matchTemplateTypeForPhase_(name, colsByPhase[phase] || []);
      if (match) row[match.col] = 'x';
    });
    newRows.push(row);
  });

  if (newRows.length > 0) {
    mapSheet.getRange(mapSheet.getLastRow() + 1, 1, newRows.length, width).setValues(newRows);
  }
}

// Reads the "Checklist Type Mapping" sheet (same matrix layout as "Asset
// Matrix") into { templateName: [{phase, label}, ...] } — a template can
// legitimately map to more than one (phase, type) pair (e.g. the same
// "Tag" template reused at both L2 and L3), so each name collects every
// 'x' mark on its row rather than just one.
function readChecklistTypeMapping_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Checklist Type Mapping');
  const map = {};
  if (!sheet) return map;
  const typeCols = parseMatrixTypeColumns_(sheet);
  if (typeCols.length === 0) return map;
  const data = sheet.getDataRange().getDisplayValues();
  for (let r = 2; r < data.length; r++) {
    const name = String(data[r][0] || '').trim();
    if (!name) continue;
    typeCols.forEach(tc => {
      const mark = String(data[r][tc.col] || '').trim().toLowerCase();
      if (mark === 'x') {
        if (!map[name]) map[name] = [];
        map[name].push({ phase: tc.phase, label: tc.label });
      }
    });
  }
  return map;
}

function fetchAndUpdateTestData(projectId=45) {
  console.log("Fetching Data");
  var testApiUrl = 'https://google.cxalloy.com/api/v1/test';
  var allTestData = fetchPaginatedPostData(testApiUrl, projectId, ['attempts']);
  // Modify test data to extract relevant fields from 'attempts' as keys in allTestData
  console.log("Modifying Test data")
  for (var i = 0; i <allTestData.length; i++) {
    // Extract attempts from the row for unpacking
    var attempts = allTestData[i]["attempts"]
    // Unpack required fields from attempts to new columns in the row
    allTestData[i]["status_change_date"] = attempts.length ? attempts[attempts.length - 1]["status_change_date"] : "";
    // Delete attempts
    // delete allTestData[i]["attempts"]
  }
  // Update sheet with Data
  console.log("Updating Data")
  populateSheetWithData('Tests', allTestData);
}

function fetchAndUpdateIssueData(projectId=45) {
  console.log("Fetching Data");
  var issueApiUrl = 'https://google.cxalloy.com/api/v1/issue';
  var allIssueData = fetchPaginatedPostData(issueApiUrl, projectId, ['comments', 'time_to_close', 'extended_status', 'collaborators']);
  //Modify issue data to extract relevant fields from 'extended_status' as keys in allIssueData
  console.log("Modifying Issue Data")
  for (var i = 0; i< allIssueData.length; i++) {
    //Extract extended status from the row for unpacking
    var extended_status = allIssueData[i]["extended_status"]
    //Unpack required fields from the extended status to new columns in the row
    allIssueData[i]["open_date"] = extended_status["open_date"];
    allIssueData[i]["open_person"] = extended_status["open_person"];
    allIssueData[i]["in_progress_date"] = extended_status["in_progress_date"];
    allIssueData[i]["in_progress_person"] = extended_status["in_progress_person"];
    allIssueData[i]["pending_review_date"] = extended_status["pending_review_date"];
    allIssueData[i]["pending_review_person"] = extended_status["pending_review_person"];
    allIssueData[i]["closed_date"] = extended_status["closed_date"];
    allIssueData[i]["closed_person"] = extended_status["closed_person"];
    // Delete extended_status
    //delete allIssueData[i]["extended_status"]

    //Extract comments from the row for unpacking
      var comments = allIssueData[i]["comments"];
      if(!comments) {
        allIssueData[i]["comments"] = "";
        comments = [{
          "created_name": "",
          "comment": "",
          "issuecomment_id": "",
          "comment_date_created": "",
          "fk_issue": "",
        }]
      }
      var comment = comments[0]
      //Unpack required fields from the comments to new columns in the row
      allIssueData[i]["created_name"] = comment["created_name"];
      allIssueData[i]["comment"] = comment["comment"];
      allIssueData[i]["issuecomment_id"] = comment["issuecomment_id"];
      allIssueData[i]["comment_date_created"] = comment["date_created"];
      allIssueData[i]["fk_issue"] = comment["fk_issue"];
      // Delete comment
      // delete allIssueData[i]["comments"]
  }
  // Update sheet with Data
  console.log("Updating Issue Data")
  populateSheetWithData('Issues', allIssueData);
}

// General function to fetch data for GET requests
function fetchData(apiUrl) {
  var response = sendRequest(apiUrl, 'get');
  return response;
}

// Function to handle paginated requests (GET and POST)
function fetchPaginatedData(apiUrl) {
  var allData = [];
  var page = 1;
  var maxRecordsPerRequest = 500;
  var moreDataAvailable = true;

  while (moreDataAvailable) {
    var response = sendRequest(apiUrl + '&page=' + page, 'get');
    allData = allData.concat(response);
    moreDataAvailable = response.length === maxRecordsPerRequest;
    page++;
  }
  return allData;
}

// Combined function for paginated POST requests (for checklist and test)
function fetchPaginatedPostData(apiUrl, projectId, include) {
  var allData = [];
  var page = 1;
  var maxRecordsPerRequest = 500;
  var moreDataAvailable = true;

  while (moreDataAvailable) {
    var requestBody = {
      'project_id': projectId,
      'page': page,
      'include': include
    };
    var response = sendRequest(apiUrl, 'post', requestBody);
    console.log(`Fetched page ${page} with ${(response.records || []).length} records`);
    allData = allData.concat(response.records || []);
    moreDataAvailable = (response.records || []).length === maxRecordsPerRequest;
    page++;
  }
  console.log(`Completed! Fetched ${page - 1} pages and ${allData.length} records`);
  return allData;
}

// Optimized sheet population
function populateSheetWithData(sheetName, data) {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName(sheetName) || spreadsheet.insertSheet(sheetName);
  sheet.clear();

  if (Array.isArray(data) && data.length > 0) {
    var headers = Object.keys(data[0]);
    var rows = data.map(item => headers.map(header => item[header] || ''));
    sheet.appendRow(headers);
    if (rows.length > 0) {
      sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    }
  } else {
    sheet.appendRow(['No data available']);
  }
}

// Reads the "Asset Matrix" tab: column A is the asset allowlist, row 1 has
// merged "Level 2"/"Level 3"/"Level 4" phase labels (only the first cell
// of each merge is populated), row 2 has the per-column checklist-type
// label (Tag, Elec, NETA, ...), and an 'x' in a data row marks that asset
// as requiring that type at that phase.
function readAssetMatrix_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Asset Matrix');
  const empty = { assets: new Set(), requirements: {}, typesByPhase: { L2: [], L3: [], L4: [] } };
  if (!sheet) return empty;

  const data = sheet.getDataRange().getDisplayValues();
  if (data.length < 3) return empty;

  // A column only counts as a checklist-type column if it has BOTH a
  // resolved phase AND its own label in row 2 — this naturally excludes
  // the Asset column and the i2/i3 helper columns (blank row-2 label).
  const typeCols = parseMatrixTypeColumns_(sheet); // { col, phase, label }

  const typesByPhase = { L2: [], L3: [], L4: [] };
  typeCols.forEach(tc => {
    if (!typesByPhase[tc.phase]) typesByPhase[tc.phase] = [];
    if (!typesByPhase[tc.phase].includes(tc.label)) typesByPhase[tc.phase].push(tc.label);
  });

  const assets = new Set();
  const requirements = {};
  for (let r = 2; r < data.length; r++) {
    const assetName = String(data[r][0] || '').trim();
    if (!assetName) continue;
    assets.add(assetName);
    requirements[assetName] = {};
    typeCols.forEach(tc => {
      const mark = String(data[r][tc.col] || '').trim().toLowerCase();
      if (mark === 'x') {
        if (!requirements[assetName][tc.phase]) requirements[assetName][tc.phase] = new Set();
        requirements[assetName][tc.phase].add(tc.label);
      }
    });
  }

  return { assets, requirements, typesByPhase };
}

function doGet(e) {
  var action = e.parameter.action;

   if (action === 'getPeople') return jsonResponse_(readFilteredSheet_('People', e.parameter));


   if (action === 'getChecklists') return jsonResponse_(readFilteredSheet_('Checklists', e.parameter));
   if (action === 'getIssues') return jsonResponse_(readFilteredSheet_('Issues', e.parameter));
   if (action === 'getCxAlloySettings') return jsonResponse_(readFilteredSheet_('CxAlloy Settings', {}));

    if (e.parameter.action === 'getDashboardData') {
        return buildDashboardJson_(e.parameter.project_id);
      }

  if (action === 'getAppConfig') {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("App Config");
      if (!sheet) {
          return ContentService.createTextOutput(JSON.stringify({ status: 'success', data: null })).setMimeType(ContentService.MimeType.JSON);
      }
      const dataStr = sheet.getRange("A1").getValue();
      let parsedData = null;
      try { if (dataStr) parsedData = JSON.parse(dataStr); } catch(e) {}

      return ContentService.createTextOutput(JSON.stringify({
          status: 'success',
          data: parsedData
      })).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'getScheduleConfig') {
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Schedule Config");
      if (!sheet) {
          return ContentService.createTextOutput(JSON.stringify({ status: 'success', data: null })).setMimeType(ContentService.MimeType.JSON);
      }

      const dataStr = sheet.getRange("A1").getValue();
      let parsedData = null;
      try { if (dataStr) parsedData = JSON.parse(dataStr); } catch(e) {}

      return ContentService.createTextOutput(JSON.stringify({
          status: 'success',
          data: parsedData
      })).setMimeType(ContentService.MimeType.JSON);
  }

  // NEW: Read Equivalent Activities from Settings Tab
  if (action === 'getEqActivities') {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Settings");
    if (!sheet) return ContentService.createTextOutput(JSON.stringify({ status: 'error' }));

    const data = sheet.getDataRange().getValues();
    const headers = data[0] || [];

    const l2Idx = headers.indexOf('Level 2 Status Names');
    const l3Idx = headers.indexOf('Level 3 Status Names');
    const l4Idx = headers.indexOf('Level 4 Status Names');

    let l2 = [], l3 = [], l4 = [];

    for (let i = 1; i < data.length; i++) {
        if (l2Idx !== -1 && data[i][l2Idx]) l2.push(String(data[i][l2Idx]));
        if (l3Idx !== -1 && data[i][l3Idx]) l3.push(String(data[i][l3Idx]));
        if (l4Idx !== -1 && data[i][l4Idx]) l4.push(String(data[i][l4Idx]));
    }

    return ContentService.createTextOutput(JSON.stringify({
        status: 'success',
        data: { L2: l2, L3: l3, L4: l4 }
    })).setMimeType(ContentService.MimeType.JSON);
  }

if (action === 'getPhaseRules') {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Phase Rules LP");
    const data = sheet.getDataRange().getValues();
    return ContentService.createTextOutput(JSON.stringify({ status: 'success', data: data })).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'getEquipmentAttributes') {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName('Attributes'); // Must match the sheet generated by your other script

    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify({error: "Equipment sheet not found"})).setMimeType(ContentService.MimeType.JSON);
    }

    const data = sheet.getDataRange().getDisplayValues();
    if (data.length < 2) {
      return ContentService.createTextOutput(JSON.stringify({data: []})).setMimeType(ContentService.MimeType.JSON);
    }

    const headers = data[0];
    const result = [];

    // Convert sheet to an array of objects, stripping out entirely blank attributes
    for (let i = 1; i < data.length; i++) {
      let obj = {};
      for (let j = 0; j < headers.length; j++) {
        const val = data[i][j].trim();
        if (val !== "") {
          obj[headers[j]] = val;
        }
      }

      // We only care about rows that have an actual Asset Name
      if (obj['Asset Name'] || obj['Asset']) {
        result.push(obj);
      }
    }

    return ContentService.createTextOutput(JSON.stringify({data: result})).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'getReady') {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("LP_Data"); // Update this to match your actual sheet name if needed
    var data = sheet.getDataRange().getValues();
    var readyItems = [];

    // Loop through rows (assuming row 0 is headers)
    for (var i = 1; i < data.length; i++) {
      // NOTE: Update these index numbers [0], [1], [2] to match the actual columns in your sheet!
      // For example, if Activity is column A, it is index 0. If it is column C, it is index 2.
      var activity = data[i][0] ? data[i][0].toString() : "";
      var asset = data[i][1] ? data[i][1].toString() : "";
      var statusVal = data[i][2] ? data[i][2].toString().toLowerCase() : "";

      // If the status contains the word "ready"
      if (statusVal.indexOf("ready") !== -1) {
        readyItems.push({ activity: activity, asset: asset });
      }
    }

    return ContentService.createTextOutput(JSON.stringify({ readyItems: readyItems }))
      .setMimeType(ContentService.MimeType.JSON);
  }

if (action === 'notifyAdmit') {
  var userEmail = e.parameter.email;
  var subject = "✅ Access Granted: QCx LaunchPad";
  var body = "Great news!\n\nYour request for access to the QCx LaunchPad has been approved. " +
             "You can now sign in using your PIN.\n\n" +
             "Access the LaunchPad here: www.launchpad.criticalarccx.com";

  MailApp.sendEmail(userEmail, subject, body);
  return ContentService.createTextOutput(JSON.stringify({success: true})).setMimeType(ContentService.MimeType.JSON);
}

if (action === 'notifyDecline') {
  var userEmail = e.parameter.email;
  var subject = "Update regarding your QCx LaunchPad request";
  var body = "Hello,\n\nAt this time, your request for access to the QCx LaunchPad has been declined. " +
             "If you believe this is an error, please contact the administrator directly.";

  MailApp.sendEmail(userEmail, subject, body);
  return ContentService.createTextOutput(JSON.stringify({success: true})).setMimeType(ContentService.MimeType.JSON);
}

  // --- THIS PART IS REQUIRED FOR REQUEST ACCESS ---
  if (action === 'requestAccess') {
    var userEmail = e.parameter.email;
    var adminEmail = e.parameter.admin;

var appUrl = "www.launchpad.criticalarccx.com"; // Use your live URL
var subject = "🚀 New Access Request: LaunchPad";
var body = "A user is requesting access to the QCx LaunchPad.\n\n" +
           "User Email: " + userEmail + "\n\n" +
           "To grant access, click the link below and log in as Admin:\n" +
           appUrl + "?grant=" + encodeURIComponent(userEmail);
    try {
      MailApp.sendEmail(adminEmail, subject, body);
      // The frontend is waiting for this EXACT success: true response
      return ContentService.createTextOutput(JSON.stringify({success: true}))
        .setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({success: false, error: err.toString()}))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  if (action === 'lookup') {
    const col3 = e.parameter.col3;
    const col4 = e.parameter.col4;

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("LP_Data");
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] == col3 && data[i][1] == col4) {
        const cell = sheet.getRange(i + 1, 3);
        const durationCell = sheet.getRange(i + 1, 4);

        const textValue = cell.getDisplayValue();
        const richText = cell.getRichTextValue();
        const linkUrl = richText ? richText.getLinkUrl() : null;

        // 🟢 THE FIX: Append "hours" if it isn't already there
        let durationVal = durationCell.getDisplayValue();
        if (durationVal && !String(durationVal).toLowerCase().includes('hour')) {
            durationVal = String(durationVal).trim() + " hours";
        }

        return ContentService.createTextOutput(JSON.stringify({
          result: textValue,
          url: linkUrl,
          duration: durationVal
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    return ContentService.createTextOutput(JSON.stringify({ result: "No Rule Matched / N/A" })).setMimeType(ContentService.MimeType.JSON);
  }

  if (e.parameter.action === 'getExternalDashboardData') {
    return getExternalData();
}
  let debugLogs = [];
  try {
    // =========================================================================
    const projectID = 45; // <--- ENTER PROJECT ID HERE
    // =========================================================================
    debugLogs.push(`Project ID configured as: '${projectID}'`);

    const ss = SpreadsheetApp.getActiveSpreadsheet();

    const assetSheet = ss.getSheetByName('Output');
    const clSheet = ss.getSheetByName('Checklists');
    const issueSheet = ss.getSheetByName('Issues');
    const testSheet = ss.getSheetByName('Tests');
    const settingsSheet = ss.getSheetByName('Setup Page') || ss.getSheetByName('Settings');
    const phaseRulesSheet = ss.getSheetByName('Phase Rules');

    if (!assetSheet) return ContentService.createTextOutput(JSON.stringify({error: "The 'Output' tab is missing."})).setMimeType(ContentService.MimeType.JSON);

    const assetData = assetSheet.getDataRange().getDisplayValues(); // Forced to string
    const equipmentData = ss.getSheetByName('Equipment') ? ss.getSheetByName('Equipment').getDataRange().getDisplayValues() : [];
    const clData = clSheet ? clSheet.getDataRange().getDisplayValues() : [];
    const issueData = issueSheet ? issueSheet.getDataRange().getDisplayValues() : [];
    const testData = testSheet ? testSheet.getDataRange().getDisplayValues() : [];
    const settingsData = settingsSheet ? settingsSheet.getDataRange().getDisplayValues() : [];
    const phaseRulesData = phaseRulesSheet ? phaseRulesSheet.getDataRange().getDisplayValues() : [];

    debugLogs.push(`Issues Sheet Found: ${!!issueSheet}. Rows: ${issueData.length}`);

    const buildMap = (data, idColNames, statusColNames, priorityColName, linkType) => {
      const map = {};
      if (data.length > 1) {
        const headers = data[0].map(h => h.toString().trim().toLowerCase());

        if (linkType === 'issue') {
            debugLogs.push(`Issue Headers Detected: [${headers.join(', ')}]`);
        }

        let idIdx = -1;
        for (let name of idColNames) {
          idIdx = headers.indexOf(name.toLowerCase());
          if (idIdx > -1) {
              if (linkType === 'issue') debugLogs.push(`Issue ID matched to header: '${name}' (Index: ${idIdx})`);
              break;
          }
        }

        let statusIdx = -1;
        for (let name of statusColNames) {
          statusIdx = headers.indexOf(name.toLowerCase());
          if (statusIdx > -1) break;
        }

        const priorityIdx = priorityColName ? headers.indexOf(priorityColName.toLowerCase()) : -1;

        // Read each row's own project_id (from this sheet — Checklists,
        // Tests, or Issues — whichever one is being built right now)
        // instead of relying on a single shared projectID for every link.
        let rowProjIdIdx = headers.indexOf('project_id');
        if (rowProjIdIdx === -1) rowProjIdIdx = headers.indexOf('project id');

        let sysIdIdx = -1;

        if (linkType === 'checklist') {
            sysIdIdx = headers.indexOf('checklist_id');
            if (sysIdIdx === -1) sysIdIdx = headers.indexOf('checklist id');
            if (sysIdIdx === -1) sysIdIdx = headers.indexOf('id');
        }
        if (linkType === 'test') {
            sysIdIdx = headers.indexOf('test_id');
            if (sysIdIdx === -1) sysIdIdx = headers.indexOf('test id');
            if (sysIdIdx === -1) sysIdIdx = headers.indexOf('id');
        }
        if (linkType === 'issue') {
            sysIdIdx = headers.indexOf('issue_id');
            if (sysIdIdx === -1) sysIdIdx = headers.indexOf('issue id');
            if (sysIdIdx === -1) sysIdIdx = headers.indexOf('id');
        }

        if (sysIdIdx === -1) sysIdIdx = idIdx;

        if (linkType === 'issue') {
            debugLogs.push(`Resolved Issue ID Index: ${idIdx}, System ID Index for URL: ${sysIdIdx}`);
        }

        if (idIdx > -1) {
          for (let i = 1; i < data.length; i++) {
            let id = data[i][idIdx];
            if (id) {
              let status = (statusIdx > -1 && data[i][statusIdx]) ? data[i][statusIdx] : 'Unknown';
              if (priorityIdx > -1 && data[i][priorityIdx]) {
                status = data[i][priorityIdx].toString().trim() + ' - ' + status;
              }

              let link = '';
              let sId = sysIdIdx > -1 ? data[i][sysIdIdx] : data[i][idIdx];
              // This row's own project_id wins; the globally-resolved
              // projectID is only a fallback for rows where this sheet
              // doesn't carry the column.
              let rowProjectID = (rowProjIdIdx > -1 && data[i][rowProjIdIdx]) ? data[i][rowProjIdIdx] : projectID;

              if (rowProjectID && rowProjectID !== 'ENTER_YOUR_projectID_HERE' && sId) {
                 if (linkType === 'checklist') link = `https://google.cxalloy.com/project/${rowProjectID}/checklists/${sId}`;
                 else if (linkType === 'test') link = `https://google.cxalloy.com/project/${rowProjectID}/test/${sId}`;
                 else if (linkType === 'issue') link = `https://google.cxalloy.com/project/${rowProjectID}/constructionissue/${sId}#sort%5B%5D=identified-d`;
              }

              map[id.toString().trim()] = { status: status, link: link };

              if (linkType === 'issue' && i === 1) {
                  debugLogs.push(`Sample mapping Issue -> Display ID: '${id.toString().trim()}', Built URL: '${link}'`);
              }
            }
          }
        } else if (linkType === 'issue') {
            debugLogs.push(`ERROR: Could not find any valid Issue ID column in the Issues tab! Checked for: [${idColNames.join(', ')}]`);
        }
      }
      return map;
    };

    const clMap = buildMap(clData, ['Checklist ID', 'number', 'id'], ['status', 'workflow status'], null, 'checklist');
    const testMap = buildMap(testData, ['Test ID', 'Checklist ID', 'number', 'id'], ['status', 'workflow status'], null, 'test');
    const issueMap = buildMap(issueData, ['Issue ID', 'Issue Number', 'Name', 'ID'], ['status', 'workflow status', 'issue status'], 'priority', 'issue');

    const eqMap = {};
    if (equipmentData.length > 1) {
       const eqHeaders = equipmentData[0].map(h => h.toString().trim().toLowerCase());
       let nameIdx = eqHeaders.indexOf('asset');
       if (nameIdx === -1) nameIdx = eqHeaders.indexOf('name');
       if (nameIdx === -1) nameIdx = eqHeaders.indexOf('equipment');

       let eqSysIdx = eqHeaders.indexOf('equipment_id');
       if (eqSysIdx === -1) eqSysIdx = eqHeaders.indexOf('equipment id');

       if (nameIdx > -1 && eqSysIdx > -1) {
          for (let i = 1; i < equipmentData.length; i++) {
             let name = equipmentData[i][nameIdx];
             let eId = equipmentData[i][eqSysIdx];
             if (name && projectID && projectID !== 'ENTER_YOUR_projectID_HERE' && eId) {
                 eqMap[name.toString().trim()] = `https://google.cxalloy.com/project/${projectID}/equipment/${eId}`;
             }
          }
       }
    }

    let config = {
      showL2Gate: true, showL3Gate: true, showL4Gate: true,
      showL2Supp: true, showL3Supp: true, showL4Supp: true,
      openStatuses: [], closedStatuses: [], cxCompleteStatuses: [],
      testOpenStatuses: [], testClosedStatuses: [],
      issueOpenStatuses: [], issueClosedStatuses: [],
      gatingIssues: [], nonGatingIssues: [],
      checklistTypesByPhase: { L2: [], L3: [], L4: [] },
      phaseRules: [], fallbackColor: '#f5f5f5',
      customHeaders: {
          zoneTitle: 'Zone 1',
          areaPrefix: 'Area',
          l2Phase: 'L2 Verification', l2Gate: 'Gate CL', l2Status: 'Status',
          l3Phase: 'L3 Functional', l3Gate: 'Gate CL', l3Status: 'Status',
          l4Phase: 'L4 Integrated', l4Gate: 'Gate CL', l4Status: 'Status',
          issPhase: 'Asset Issues', issStatus: 'Open Issues'
      },
      maxCols: { l2: 0, l3: 0, l4: 0, iss: 0 }
    };

    const assetMatrix = readAssetMatrix_();
    config.checklistTypesByPhase = {
      L2: assetMatrix.typesByPhase.L2 || [],
      L3: assetMatrix.typesByPhase.L3 || [],
      L4: assetMatrix.typesByPhase.L4 || []
    };

    if (phaseRulesData.length > 1) {
      for (let i = 1; i < phaseRulesData.length; i++) {
        let row = phaseRulesData[i];
        if (String(row[1] || '').trim() === "" && String(row[8] || '').trim() === "") continue;
        config.phaseRules.push({
          active: row[0],
          phase: row[1],
          prevStatus: row[2],
          maxGate: row[3],
          maxSupport: row[4],
          maxSupportPendingCx: row[5],
          maxGatingIssues: row[6],
          maxNonGatingIssues: row[7],
          resultingStatus: row[8],
          includeOpenCHKs: row[9],
          includeOpenGatingIssues: row[10],
          color: row[11] || '#e0e0e0'
        });
      }
    }

    function extractStatuses(headerNames, targetArray, defaultColor) {
      if(settingsData.length === 0) return;
      for(let r = 0; r < settingsData.length; r++) {
        for(let c = 0; c < settingsData[r].length; c++) {
          let cellVal = String(settingsData[r][c]).toLowerCase().trim();
          if(headerNames.includes(cellVal)) {
            for(let i = r + 1; i < settingsData.length; i++) {
              let val = String(settingsData[i][c] || '').trim();
              if(val === "") break;
              let color = String(settingsData[i][c+1] || '').trim() || defaultColor;
              targetArray.push({name: val, color: color});
            }
            return;
          }
        }
      }
    }

    extractStatuses(['checklist open statuses', 'checklist open status'], config.openStatuses, '#fff9c4');
    extractStatuses(['checklist complete statuses', 'checklist closed statuses'], config.closedStatuses, '#c8e6c9');
    extractStatuses(['checklist cx complete statuses', 'cx complete status'], config.cxCompleteStatuses, '#81c784');
    extractStatuses(['test open statuses', 'test open status'], config.testOpenStatuses, '#fff9c4');
    extractStatuses(['test complete statuses', 'test closed statuses'], config.testClosedStatuses, '#c8e6c9');
    extractStatuses(['issue open statuses', 'issue open status'], config.issueOpenStatuses, '#fff9c4');
    extractStatuses(['issue complete statuses', 'issue closed statuses'], config.issueClosedStatuses, '#c8e6c9');
    extractStatuses(['gating issues', 'gating issue statuses'], config.gatingIssues, '#ffcdd2');
    extractStatuses(['non-gating issues', 'non gating issues', 'non-gating issue statuses'], config.nonGatingIssues, '#ffe0b2');

    if (settingsData.length > 0) {
      for(let r = 0; r < settingsData.length; r++) {
          for(let c = 0; c < settingsData[r].length; c++) {
              let cellVal = String(settingsData[r][c]).toLowerCase().trim();

              if(cellVal === 'fallback color') {
                  let val = String(settingsData[r][c+1] || '').trim();
                  if(val) config.fallbackColor = val;
              }

              if(cellVal === 'zone title') config.customHeaders.zoneTitle = String(settingsData[r][c+1] || '').trim() || 'Zone 1';
              if(cellVal === 'area prefix') config.customHeaders.areaPrefix = String(settingsData[r][c+1] || '').trim() || 'Area';
              if(cellVal === 'l2 phase name') config.customHeaders.l2Phase = String(settingsData[r][c+1] || '').trim() || 'L2 Verification';
              if(cellVal === 'l2 gate name') config.customHeaders.l2Gate = String(settingsData[r][c+1] || '').trim() || 'Gate CL';
              if(cellVal === 'l2 status name') config.customHeaders.l2Status = String(settingsData[r][c+1] || '').trim() || 'Status';
              if(cellVal === 'l3 phase name') config.customHeaders.l3Phase = String(settingsData[r][c+1] || '').trim() || 'L3 Functional';
              if(cellVal === 'l3 gate name') config.customHeaders.l3Gate = String(settingsData[r][c+1] || '').trim() || 'Gate CL';
              if(cellVal === 'l3 status name') config.customHeaders.l3Status = String(settingsData[r][c+1] || '').trim() || 'Status';
              if(cellVal === 'l4 phase name') config.customHeaders.l4Phase = String(settingsData[r][c+1] || '').trim() || 'L4 Integrated';
              if(cellVal === 'l4 gate name') config.customHeaders.l4Gate = String(settingsData[r][c+1] || '').trim() || 'Gate CL';
              if(cellVal === 'l4 status name') config.customHeaders.l4Status = String(settingsData[r][c+1] || '').trim() || 'Status';
              if(cellVal === 'iss phase name') config.customHeaders.issPhase = String(settingsData[r][c+1] || '').trim() || 'Asset Issues';
              if(cellVal === 'iss status name') config.customHeaders.issStatus = String(settingsData[r][c+1] || '').trim() || 'Open Issues';

              if (r + 1 < settingsData.length) {
                  let belowVal = String(settingsData[r+1][c] || '').toLowerCase().trim();
                  if(cellVal === 'l2 gate') config.showL2Gate = (belowVal !== 'false' && belowVal !== 'no' && belowVal !== '');
                  if(cellVal === 'l3 gate') config.showL3Gate = (belowVal !== 'false' && belowVal !== 'no' && belowVal !== '');
                  if(cellVal === 'l4 gate') config.showL4Gate = (belowVal !== 'false' && belowVal !== 'no' && belowVal !== '');
                  if(cellVal === 'l2 support') config.showL2Supp = (belowVal !== 'false' && belowVal !== 'no' && belowVal !== '');
                  if(cellVal === 'l3 support') config.showL3Supp = (belowVal !== 'false' && belowVal !== 'no' && belowVal !== '');
                  if(cellVal === 'l4 support') config.showL4Supp = (belowVal !== 'false' && belowVal !== 'no' && belowVal !== '');
              }
          }
      }
    }

    if(config.openStatuses.length === 0) config.openStatuses = [{name: 'Open', color: '#fff9c4'}];
    if(config.closedStatuses.length === 0) config.closedStatuses = [{name: 'Closed', color: '#c8e6c9'}];

    const assetHeaders = assetData[0].map(h => h.toString().trim());

    let assetColIdx = assetHeaders.findIndex(h => h.toLowerCase() === 'asset' || h.toLowerCase() === 'name' || h.toLowerCase() === 'equipment');
    if (assetColIdx === -1) assetColIdx = 0;
    const validRows = assetData.slice(1).filter(row => row[assetColIdx] && String(row[assetColIdx]).trim() !== '' && assetMatrix.assets.has(String(row[assetColIdx]).trim()));

    // Column counting, generalized to one dynamic entry per (phase, type
    // label) pair instead of hardcoded Gate/Support regexes — keyed by
    // "L2 Tag" etc., same key shape as generateChecklistMatrix()'s
    // activeCategories[].name.
    let maxCols = { iss: 0 };
    ['L2', 'L3', 'L4'].forEach(phase => {
      (config.checklistTypesByPhase[phase] || []).forEach(label => {
        maxCols[phase + ' ' + label] = 1;
      });
    });
    assetHeaders.forEach(h => {
        let mIss = h.match(/Issue.*?(\d+)/i); if (mIss) maxCols.iss = Math.max(maxCols.iss, parseInt(mIss[1]));
        ['L2', 'L3', 'L4'].forEach(phase => {
          (config.checklistTypesByPhase[phase] || []).forEach(label => {
            const key = phase + ' ' + label;
            const re = new RegExp('^' + phase + '\\s*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*?(\\d+)$', 'i');
            const m = h.match(re);
            if (m) maxCols[key] = Math.max(maxCols[key] || 1, parseInt(m[1]));
          });
        });
    });

    let actualMaxCols = { iss: 0 };
    Object.keys(maxCols).forEach(k => { if (k !== 'iss') actualMaxCols[k] = 1; });

    const result = validRows.map(row => {
      let obj = {};
      assetHeaders.forEach((header, index) => {
        obj[header] = row[index] === "" ? "" : row[index];
      });

      let assetName = obj['Asset'] ? obj['Asset'].toString().trim() : '';
      if (assetName && eqMap[assetName]) {
         obj['Asset_Link'] = eqMap[assetName];
      } else {
         let eIdx = assetHeaders.findIndex(h => h.toLowerCase() === 'equipment_id' || h.toLowerCase() === 'equipment id');
         if (projectID && projectID !== 'ENTER_YOUR_projectID_HERE' && eIdx > -1 && row[eIdx]) {
            obj['Asset_Link'] = `https://google.cxalloy.com/project/${projectID}/equipment/${row[eIdx]}`;
         }
      }

      ['L2', 'L3', 'L4'].forEach(level => {
        let currentMap = (level === 'L4') ? testMap : clMap;
        (config.checklistTypesByPhase[level] || []).forEach(label => {
          const catKey = level + ' ' + label;
          const maxN = maxCols[catKey] || 1;
          for (let i = 1; i <= maxN; i++) {
            const cellKeyRegex = new RegExp('^' + level + '\\s*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*?' + i + '$', 'i');
            const cellKey = Object.keys(obj).find(k => cellKeyRegex.test(k)) || `${catKey} CL ${i}`;

            if (obj[cellKey]) {
              let cleanId = obj[cellKey].toString().replace(/\(.*?\)/g, '').trim();
              if (cleanId && cleanId !== 'N/A' && cleanId !== 'Clear' && cleanId !== '-') {
                  let matchData = currentMap[cleanId] || {status: 'Unknown', link: ''};
                  obj[cellKey] = `${cleanId} (${matchData.status})`;
                  obj[cellKey + '_Link'] = matchData.link;
                  actualMaxCols[catKey] = Math.max(actualMaxCols[catKey] || 1, i);
              }
            }
          }
        });
      });

      let firstIssueFound = false;
      for (let i = 1; i <= maxCols.iss; i++) {
        let issueKey = `Issue ${i}`;
        if (obj[issueKey]) {
          let cleanId = obj[issueKey].toString().trim();
          let matchData = issueMap[cleanId] || {status: 'Unknown', link: ''};
          obj[issueKey] = `${cleanId} (${matchData.status})`;
          obj[issueKey + '_Link'] = matchData.link;

          if (!firstIssueFound && cleanId && cleanId !== 'N/A' && cleanId !== 'Clear' && cleanId !== '-') {
              debugLogs.push(`Cross-referencing Issue from Output tab: Looking for Issue ID '${cleanId}'. Found link: '${matchData.link}'`);
              firstIssueFound = true;
          }

          if (cleanId && cleanId !== 'N/A' && cleanId !== 'Clear' && cleanId !== '-') {
             actualMaxCols.iss = Math.max(actualMaxCols.iss, i);
          }
        }
      }
            Object.keys(obj).forEach(k => { if (obj[k] === "") delete obj[k]; });
      return obj;
    });

    config.maxCols = actualMaxCols;

    // Send payload + debug logs back to HTML
    return ContentService.createTextOutput(JSON.stringify({
        data: result,
        config: config,
        debug: debugLogs
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({error: err.toString(), stack: err.stack, debug: debugLogs})).setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if (payload.action === 'setScheduleConfig') {
      let sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Schedule Config");
      if (!sheet) {
          sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet("Schedule Config");
      }
      sheet.getRange("A1").setValue(JSON.stringify(payload.data));

      return ContentService.createTextOutput(JSON.stringify({ status: 'success' })).setMimeType(ContentService.MimeType.JSON);
  }

  if (payload.action === 'setAppConfig') {
      let sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("App Config");
      if (!sheet) {
          sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet("App Config");
      }
      sheet.getRange("A1").setValue(JSON.stringify(payload.data));

      return ContentService.createTextOutput(JSON.stringify({ status: 'success' })).setMimeType(ContentService.MimeType.JSON);
  }

    // =========================================================================
    // 1. SAVE SINGLE MARKED-UP IMAGE TO GOOGLE DRIVE (RETURNS FILENAME)
    // =========================================================================
    if (payload.action === 'saveImageOnly') {
      try {
        const base64Data = payload.image.replace(/^data:image\/(png|jpeg);base64,/, "");
        const assetName = payload.assetName || "Unknown_Asset";

        const rawScanType = payload.scanType || "Scan";
        const cleanScanType = rawScanType.replace(/[^a-zA-Z0-9_-]/g, '_');

        let rootFolder = DriveApp.getFoldersByName("Attribute Photos").hasNext() ? DriveApp.getFoldersByName("Attribute Photos").next() : DriveApp.createFolder("Attribute Photos");
        let assetFolder = rootFolder.getFoldersByName(assetName).hasNext() ? rootFolder.getFoldersByName(assetName).next() : rootFolder.createFolder(assetName);

        const uniqueString = new Date().getTime().toString().slice(-6);
        const fileName = `${cleanScanType}_${uniqueString}.jpg`;
        const imageBlob = Utilities.newBlob(Utilities.base64Decode(base64Data), 'image/jpeg', fileName);

        assetFolder.createFile(imageBlob);

        // 🟢 THE FIX: Return the generated fileName back to the iPad
        return ContentService.createTextOutput(JSON.stringify({success: true, fileName: fileName})).setMimeType(ContentService.MimeType.JSON);

      } catch (err) {
        return ContentService.createTextOutput(JSON.stringify({success: false, error: err.toString()})).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // =========================================================================
    // 2. OCR IMAGE + SUPABASE LOGGING (NO DRIVE SAVING HERE)
    // =========================================================================
    if (payload.action === 'ocrImage') {
      try {
        // --- PASTE YOUR VISION API KEY HERE ---
        const VISION_API_KEY = 'AIzaSyB-fYNCTU9sChuJ5YjN5oehwXgOPN3AqRo';
        const base64Data = payload.image.replace(/^data:image\/(png|jpeg);base64,/, "");

        const assetName = payload.assetName || "Unknown_Asset";
        const rawAttrName = payload.attributeName || "Attribute";
        const parentPhotoName = payload.photoName || "No_Photo_Saved"; // 🟢 Receives the large photo name from iPad

        // --- THE FIX: Removed the Google Drive saving code from here! ---

        // 1. Perform OCR with Google Vision API
        const visionApiUrl = `https://vision.googleapis.com/v1/images:annotate?key=${VISION_API_KEY}`;
        const requestBody = {
          requests: [{ image: { content: base64Data }, features: [{ type: "TEXT_DETECTION" }] }]
        };

        const options = {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify(requestBody),
          muteHttpExceptions: true
        };

        const response = UrlFetchApp.fetch(visionApiUrl, options);
        const result = JSON.parse(response.getContentText());

        if (result.error) {
           return ContentService.createTextOutput(JSON.stringify({success: false, error: "Google Cloud Error: " + result.error.message})).setMimeType(ContentService.MimeType.JSON);
        }

        let extractedText = "";
        if (result.responses && result.responses[0] && result.responses[0].fullTextAnnotation) {
          extractedText = result.responses[0].fullTextAnnotation.text;
        }

        const cleanExtractedText = extractedText.replace(/\n+/g, ' ').trim();

        // 2. LOG TO SUPABASE
        // --- PASTE YOUR SUPABASE URL AND KEY HERE ---
        const SUPABASE_URL = "https://rcnxetcomdrlxvlarqoc.supabase.co";
        const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJjbnhldGNvbWRybHh2bGFycW9jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY0NDIyMjksImV4cCI6MjA5MjAxODIyOX0.gP37sT5OrCOVRZXekMrBZHm5mtfnr6JrC2YGflWsDQU";

        if (SUPABASE_URL !== "YOUR_SUPABASE_URL") {
           const supabasePayload = {
               scan_date: new Date().toISOString(),
               asset_name: assetName,
               attribute_name: rawAttrName,
               photo_name: parentPhotoName, // 🟢 Logs the large photo's filename!
               scanned_value: cleanExtractedText
           };

           const supaOptions = {
               method: 'post',
               contentType: 'application/json',
               headers: {
                   'apikey': SUPABASE_KEY,
                   'Authorization': 'Bearer ' + SUPABASE_KEY,
                   'Prefer': 'return=minimal'
               },
               payload: JSON.stringify(supabasePayload),
               muteHttpExceptions: true
           };

           try {
               UrlFetchApp.fetch(`${SUPABASE_URL}/rest/v1/STY4_Attributes`, supaOptions);
           } catch (e) {
               console.error("Supabase Log Error: " + e.toString());
           }
        }

        // 3. Return the text to the iPad
        return ContentService.createTextOutput(JSON.stringify({success: true, text: cleanExtractedText})).setMimeType(ContentService.MimeType.JSON);

      } catch (err) {
        return ContentService.createTextOutput(JSON.stringify({success: false, error: err.toString()})).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // NEW: Write Equivalent Activities to Settings Tab
  if (payload.action === 'setEqActivities') {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Settings");
    if (sheet) {
        let data = sheet.getDataRange().getValues();
        let headers = data[0] || [];

        let l2Idx = headers.indexOf('Level 2 Status Names');
        let l3Idx = headers.indexOf('Level 3 Status Names');
        let l4Idx = headers.indexOf('Level 4 Status Names');

        // Create the columns at the end if they don't exist yet
        if (l2Idx === -1) { l2Idx = headers.length; headers.push('Level 2 Status Names'); sheet.getRange(1, l2Idx + 1).setValue('Level 2 Status Names'); }
        if (l3Idx === -1) { l3Idx = headers.length; headers.push('Level 3 Status Names'); sheet.getRange(1, l3Idx + 1).setValue('Level 3 Status Names'); }
        if (l4Idx === -1) { l4Idx = headers.length; headers.push('Level 4 Status Names'); sheet.getRange(1, l4Idx + 1).setValue('Level 4 Status Names'); }

        // Clear out old data from those specific columns (leaving row 1 intact)
        const lastRow = sheet.getLastRow();
        if (lastRow > 1) {
            sheet.getRange(2, l2Idx + 1, lastRow).clearContent();
            sheet.getRange(2, l3Idx + 1, lastRow).clearContent();
            sheet.getRange(2, l4Idx + 1, lastRow).clearContent();
        }

        // Write the new data down the columns
        const reqData = payload.data;
        if (reqData.L2.length > 0) sheet.getRange(2, l2Idx + 1, reqData.L2.length, 1).setValues(reqData.L2.map(v => [v]));
        if (reqData.L3.length > 0) sheet.getRange(2, l3Idx + 1, reqData.L3.length, 1).setValues(reqData.L3.map(v => [v]));
        if (reqData.L4.length > 0) sheet.getRange(2, l4Idx + 1, reqData.L4.length, 1).setValues(reqData.L4.map(v => [v]));
    }

    return ContentService.createTextOutput(JSON.stringify({ status: 'success' })).setMimeType(ContentService.MimeType.JSON);
  }

if (payload.action === 'setPhaseRules') {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Phase Rules LP");
    sheet.clearContents(); // Clear old rules
    sheet.getRange(1, 1, payload.data.length, payload.data[0].length).setValues(payload.data); // Write new rules

    return ContentService.createTextOutput(JSON.stringify({ status: 'success' })).setMimeType(ContentService.MimeType.JSON);
  }
   // =========================================================================
    // 1. SAVE ATTRIBUTES LOGIC (SCRATCH-BUILT TO MATCH POSTMAN DOCS)
    // =========================================================================
    if (payload.action === 'saveAttributes') {
      const assetName = payload.assetName;
      const changes = payload.changes;
      let debugLogs = [];

      debugLogs.push(`--- CXALLOY API PUSH DIAGNOSTICS ---`);
      debugLogs.push(`Target Asset: ${assetName}`);

      // --- STEP 1: SAVE LOCALLY TO GOOGLE SHEETS ---
      const sheet = ss.getSheetByName('Attributes');
      if (!sheet) {
        return ContentService.createTextOutput(JSON.stringify({success: false, error: "Attributes sheet not found", debug: debugLogs})).setMimeType(ContentService.MimeType.JSON);
      }

      const data = sheet.getDataRange().getValues();
      const headers = data[0];
      const assetColIndex = headers.findIndex(h => h === 'Asset Name' || h === 'Asset' || String(h).toLowerCase().trim() === 'name');

      let targetRowIndex = -1;
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][assetColIndex]).trim() === String(assetName).trim()) {
          targetRowIndex = i + 1;
          break;
        }
      }

      if (targetRowIndex !== -1) {
        changes.forEach(change => {
          const colIndex = headers.indexOf(change.attribute);
          if (colIndex !== -1) sheet.getRange(targetRowIndex, colIndex + 1).setValue(change.newValue);
        });
        debugLogs.push(`✅ Local Google Sheet updated successfully.`);
      }

      // --- STEP 2: PUSH TO CXALLOY ---
      try {
        const eqSheet = ss.getSheetByName('Equipment');
        let equipmentId = null;
        let projectId = 45; // Standard Fallback

        if (eqSheet) {
          const eqData = eqSheet.getDataRange().getValues();
          const eqHeaders = eqData[0].map(h => String(h).toLowerCase().trim());
          let nameIdx = eqHeaders.indexOf('name');
          if (nameIdx === -1) nameIdx = eqHeaders.indexOf('asset');
          let idIdx = eqHeaders.indexOf('equipment_id');
          if (idIdx === -1) idIdx = eqHeaders.indexOf('id');
          let projIdx = eqHeaders.indexOf('project_id');

          if (nameIdx > -1 && idIdx > -1) {
            for (let i = 1; i < eqData.length; i++) {
              if (String(eqData[i][nameIdx]).trim() === String(assetName).trim()) {
                equipmentId = eqData[i][idIdx];
                if (projIdx > -1 && eqData[i][projIdx]) projectId = eqData[i][projIdx];
                break;
              }
            }
          }
        }

        if (!equipmentId) {
          debugLogs.push(`ERROR: Could not find CxAlloy Equipment ID for asset: ${assetName}`);
        } else {
          debugLogs.push(`Found Equipment ID: ${equipmentId} (Project: ${projectId})`);

          var identifier = 'XwQaC1ujqwyFUDo6WIGjXtw8l';
          var secret = 'x5bhoaQw6HV6D3oD4hmtjpPj5SY41KmjK41Y22UIEwW3PPokksFvQaontc';

          // --- FETCH EXISTING ATTRIBUTE IDs VIA GET ---
          var tsGet = Math.floor(new Date().getTime() / 1000).toString();
          var sigGet = generateHmacSignature(tsGet, secret);

          // PDF Protocol: Query params go in the URL for GET requests
          var getUrl = `https://google.cxalloy.com/api/v1/equipment/${equipmentId}?project_id=${projectId}&include=attributes`;

          var getOptions = {
            'method': 'get',
            'headers': {
              'cache-control': 'no-cache',
              'content-type': 'application/json',
              'cxalloy-identifier': identifier,
              'cxalloy-signature': sigGet,
              'cxalloy-timestamp': tsGet
            },
            'muteHttpExceptions': true
          };

          var getResp = UrlFetchApp.fetch(getUrl, getOptions);

          if (getResp.getResponseCode() === 200) {
            var eqResponse = JSON.parse(getResp.getContentText());
            if (Array.isArray(eqResponse)) eqResponse = eqResponse[0];

            var targetAttributes = eqResponse.attributes || (eqResponse.data && eqResponse.data.attributes) || [];
            if (targetAttributes.length > 0) {
              const updatedAttributes = [];

              changes.forEach(change => {
                const matchedAttr = targetAttributes.find(a => String(a.name).trim().toLowerCase() === String(change.attribute).trim().toLowerCase());
                if (matchedAttr) {
                  const attrId = matchedAttr.id || matchedAttr.equipmentattribute_id || matchedAttr.attribute_id;
                  updatedAttributes.push({
                      id: parseInt(attrId, 10),
                      value: String(change.newValue).trim()
                  });
                }
              });

              if (updatedAttributes.length > 0) {
                const postUrl = `https://google.cxalloy.com/api/v1/equipmentattribute_update`;
                let successCount = 0;

                // 🟢 THE FIX: Create an array to hold all requests
                let apiRequests = [];

                for (let i = 0; i < updatedAttributes.length; i++) {
                  const attr = updatedAttributes[i];

                  const updatePayload = {
                    project_id: parseInt(projectId, 10),
                    equipment_id: parseInt(equipmentId, 10),
                    equipmentattribute_id: parseInt(attr.id, 10),
                    value: String(attr.value).trim()
                  };

                  const payloadString = JSON.stringify(updatePayload);
                  const strippedPayloadString = payloadString.replace(/\s+/g, '');

                  var tsUpdate = Math.floor(new Date().getTime() / 1000).toString();
                  var sigUpdate = generateHmacSignature(strippedPayloadString + tsUpdate, secret);

                  // Push the prepared request configuration to our array instead of sending it immediately
                  apiRequests.push({
                    'url': postUrl,
                    'method': 'post',
                    'contentType': 'application/json',
                    'headers': {
                      'cache-control': 'no-cache',
                      'cxalloy-identifier': identifier,
                      'cxalloy-signature': sigUpdate,
                      'cxalloy-timestamp': tsUpdate
                    },
                    'payload': payloadString,
                    'muteHttpExceptions': true
                  });
                }

                // 🟢 THE FIX: Fire ALL requests to CxAlloy concurrently (at the same time)
                try {
                  debugLogs.push(`Firing ${apiRequests.length} requests in parallel...`);
                  var responses = UrlFetchApp.fetchAll(apiRequests);

                  // Loop through the responses to check for success
                  responses.forEach((updateResp, index) => {
                    var code = updateResp.getResponseCode();
                    debugLogs.push(`Attr ID ${updatedAttributes[index].id} -> Response Code: ${code}`);

                    if (code === 200 || code === 201 || code === 204) {
                      successCount++;
                    } else {
                      debugLogs.push(`Failed Body: ${updateResp.getContentText().substring(0, 150)}`);
                    }
                  });
                } catch (e) {
                  debugLogs.push(`Parallel API Error: ${e.toString()}`);
                }

                if (successCount > 0) {
                  debugLogs.push(`✅ Successfully updated ${successCount} attribute(s) in CxAlloy!`);
                } else {
                  debugLogs.push(`❌ Failed to update attributes. Check the response codes above.`);
                }
              } else {
                debugLogs.push("❌ Attributes could not be mapped to CxAlloy IDs.");
              }
            }
          }
        }
      } catch (e) {
        debugLogs.push(`CRITICAL SCRIPT ERROR: ${e.toString()}`);
      }

      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        debug: debugLogs
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // =========================================================================
    // 2. ORIGINAL: SAVE SETTINGS LOGIC
    // =========================================================================
    const settingsSheet = ss.getSheetByName('Setup Page') || ss.getSheetByName('Settings');
    if (!settingsSheet) return ContentService.createTextOutput(JSON.stringify({success: false, error: 'Settings sheet not found'})).setMimeType(ContentService.MimeType.JSON);

    const data = settingsSheet.getDataRange().getValues();

    function updateSection(headerNames, newItems) {
      for (let r = 0; r < data.length; r++) {
        for (let c = 0; c < data[r].length; c++) {
          let cellVal = String(data[r][c]).toLowerCase().trim();
          if (headerNames.includes(cellVal)) {
            settingsSheet.getRange(r + 2, c + 1, 50, 2).clearContent();
            if (newItems && newItems.length > 0) {
              const writeData = newItems.map(item => [item.name, item.color]);
              settingsSheet.getRange(r + 2, c + 1, writeData.length, 2).setValues(writeData);
            }
            return;
          }
        }
      }
    }

    function updateSingleValue(headerName, value) {
      let found = false;
      for (let r = 0; r < data.length; r++) {
        for (let c = 0; c < data[r].length; c++) {
          if (String(data[r][c]).toLowerCase().trim() === headerName.toLowerCase()) {
            settingsSheet.getRange(r + 1, c + 2).setValue(value);
            found = true;
            return;
          }
        }
      }
      if (!found) {
        settingsSheet.appendRow([headerName, value]);
      }
    }

    function updateVerticalValue(headerName, value) {
      let found = false;
      for (let r = 0; r < data.length; r++) {
        for (let c = 0; c < data[r].length; c++) {
          if (String(data[r][c]).toLowerCase().trim() === headerName.toLowerCase()) {
            settingsSheet.getRange(r + 2, c + 1).setValue(value);
            found = true;
            return;
          }
        }
      }
      if (!found) {
        settingsSheet.appendRow([headerName]);
        settingsSheet.getRange(settingsSheet.getLastRow() + 1, 1).setValue(value);
      }
    }

    updateSection(['checklist open statuses', 'checklist open status'], payload.openStatuses);
    updateSection(['checklist complete statuses', 'checklist closed statuses'], payload.closedStatuses);
    updateSection(['checklist cx complete statuses', 'cx complete status'], payload.cxCompleteStatuses);
    updateSection(['test open statuses', 'test open status'], payload.testOpenStatuses);
    updateSection(['test complete statuses', 'test closed statuses'], payload.testClosedStatuses);
    updateSection(['issue open statuses', 'issue open status'], payload.issueOpenStatuses);
    updateSection(['issue complete statuses', 'issue closed statuses'], payload.issueClosedStatuses);
    updateSection(['gating issues', 'gating issue statuses'], payload.gatingIssues);
    updateSection(['non-gating issues', 'non gating issues', 'non-gating issue statuses'], payload.nonGatingIssues);

    updateSingleValue('Fallback Color', payload.fallbackColor);

    if (payload.customHeaders) {
      updateSingleValue('Zone Title', payload.customHeaders.zoneTitle);
      updateSingleValue('Area Prefix', payload.customHeaders.areaPrefix);
      updateSingleValue('L2 Phase Name', payload.customHeaders.l2Phase);
      updateSingleValue('L2 Gate Name', payload.customHeaders.l2Gate);
      updateSingleValue('L2 Status Name', payload.customHeaders.l2Status);
      updateSingleValue('L3 Phase Name', payload.customHeaders.l3Phase);
      updateSingleValue('L3 Gate Name', payload.customHeaders.l3Gate);
      updateSingleValue('L3 Status Name', payload.customHeaders.l3Status);
      updateSingleValue('L4 Phase Name', payload.customHeaders.l4Phase);
      updateSingleValue('L4 Gate Name', payload.customHeaders.l4Gate);
      updateSingleValue('L4 Status Name', payload.customHeaders.l4Status);
      updateSingleValue('Iss Phase Name', payload.customHeaders.issPhase);
      updateSingleValue('Iss Status Name', payload.customHeaders.issStatus);
    }

    updateVerticalValue('L2 Gate', payload.showL2Gate);
    updateVerticalValue('L3 Gate', payload.showL3Gate);
    updateVerticalValue('L4 Gate', payload.showL4Gate);
    updateVerticalValue('L2 Support', payload.showL2Supp);
    updateVerticalValue('L3 Support', payload.showL3Supp);
    updateVerticalValue('L4 Support', payload.showL4Supp);

    if (payload.phaseRules) {
      let prSheet = ss.getSheetByName('Phase Rules');
      if (!prSheet) prSheet = ss.insertSheet('Phase Rules');

      prSheet.getRange(1, 1, Math.max(prSheet.getLastRow(), 2), 12).clearContent();
      prSheet.getRange(1, 1, 1, 12).setValues([['Rule Active?', 'Phase', 'Required Prev Status', 'Max Gate CL Open', 'Max Support CL Open', 'Max Supp Pend. Cx', 'Max Gating Issues Open', 'Max Non-Gating Issues Open', 'Resulting Status', 'Include Open CHKs Per Phase', 'Include Open Gating Issues', 'Color']]);
      if (payload.phaseRules.length > 0) {
        const fixEq = (val) => { let s = String(val).trim(); return s.startsWith('=') ? "'" + s : val; };
        const prData = payload.phaseRules.map(r => [
            r.active, r.phase, r.prevStatus, fixEq(r.maxGate), fixEq(r.maxSupport),
            fixEq(r.maxSupportPendingCx),
            fixEq(r.maxGatingIssues), fixEq(r.maxNonGatingIssues), r.resultingStatus, r.includeOpenCHKs, r.includeOpenGatingIssues, r.color
        ]);
        prSheet.getRange(2, 1, prData.length, 12).setValues(prData);
      }
    }

    return ContentService.createTextOutput(JSON.stringify({success: true})).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({success: false, error: err.toString()})).setMimeType(ContentService.MimeType.JSON);
  }
}

function generateChecklistMatrix() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Define all sheets
  const rawDataSheet = ss.getSheetByName("Checklists");
  const testsSheet = ss.getSheetByName("Tests");
  const issuesSheet = ss.getSheetByName("Issues");
  const equipSheet = ss.getSheetByName("Equipment");
  const settingsSheet = ss.getSheetByName("Settings");
  const outputSheet = ss.getSheetByName("Output");

  // Auto-create the output sheets if they don't exist
  let countsSheet = ss.getSheetByName("Open Counts");
  if (!countsSheet) countsSheet = ss.insertSheet("Open Counts");

  let lpDataSheet = ss.getSheetByName("LP_Data");
  if (!lpDataSheet) lpDataSheet = ss.insertSheet("LP_Data");

  let needsSetup = false;

  let rulesSheet = ss.getSheetByName("Phase Rules");
  if (!rulesSheet) {
    rulesSheet = ss.insertSheet("Phase Rules");
    rulesSheet.appendRow(["Rule Active?", "Phase", "Required Prev Status", "Max Gate CL Open", "Max Support CL Open", "Max Gating Issues Open", "Max Non-Gating Issues Open", "Include Open CHKs Per Phase", "Include Open Gating Issues", "Resulting Status"]);
    rulesSheet.getRange("A2:A20").insertCheckboxes();
    rulesSheet.getRange("H2:I20").insertCheckboxes();
    rulesSheet.getRange("A1:J1").setFontWeight("bold");
    needsSetup = true;
  }

  let lpRulesSheet = ss.getSheetByName("Phase Rules LP");
  if (!lpRulesSheet) {
    lpRulesSheet = ss.insertSheet("Phase Rules LP");
    lpRulesSheet.appendRow(["Rule Active?", "Phase", "Required Prev Status", "Max Gate CL Open", "Max Support CL Open", "Max Gating Issues Open", "Max Non-Gating Issues Open", "Include Open CHKs Per Phase", "Include Open Gating Issues", "Resulting Status"]);
    lpRulesSheet.getRange("A2:A20").insertCheckboxes();
    lpRulesSheet.getRange("H2:I20").insertCheckboxes();
    lpRulesSheet.getRange("A1:J1").setFontWeight("bold");
    needsSetup = true;
  }

  if (needsSetup) {
    SpreadsheetApp.getUi().alert("I created the necessary 'Phase Rules' tab(s). Please populate them with your logic and run the script again.");
    return;
  }

  if (!equipSheet) {
    SpreadsheetApp.getUi().alert("Warning: Could not find an 'Assets' or 'Equipment' tab. Areas will default to 'Other' and Hyperlinks will not generate.");
  }

  // Get all data
  const settingsData = settingsSheet.getDataRange().getValues();
  const rawData = rawDataSheet.getDataRange().getValues();
  const testsData = testsSheet ? testsSheet.getDataRange().getValues() : [];
  const issuesData = issuesSheet ? issuesSheet.getDataRange().getValues() : [];
  const rulesData = rulesSheet.getDataRange().getValues();
  const lpRulesData = lpRulesSheet.getDataRange().getValues();
  const equipData = equipSheet ? equipSheet.getDataRange().getValues() : [];

  // --- 1. Map Settings Headers & Extract Data ---
  const settingsHeaders = settingsData[0]; // Row 1
  const settingsToggles = settingsData[1]; // Row 2

  function getSettingsList(headerName) {
    let list = [];
    let idx = settingsHeaders.indexOf(headerName);
    if (idx === -1 && headerName === "Checklist Open Statuses") idx = settingsHeaders.indexOf("Open Statuses");

    if (idx !== -1) {
      for (let i = 1; i < settingsData.length; i++) {
        let val = settingsData[i][idx];
        if (val !== undefined && val !== "" && typeof val !== 'boolean') {
          list.push(val.toString().trim().toLowerCase());
        }
      }
    }
    return list;
  }

  const checklistOpenStatuses = getSettingsList("Checklist Open Statuses");
  const checklistClosedStatuses = getSettingsList("Checklist Complete Statuses").length ? getSettingsList("Checklist Complete Statuses") : getSettingsList("Checklist Closed Statuses");
  const checklistCxCompleteStatuses = getSettingsList("Checklist Cx Complete Statuses").length ? getSettingsList("Checklist Cx Complete Statuses") : getSettingsList("Cx Complete Status");
  const testOpenStatuses = getSettingsList("Test Open Statuses");
  const issueOpenStatuses = getSettingsList("Issue Open Statuses");
  const issueClosedStatuses = getSettingsList("Issue Closed Statuses");
  const gatingIssueTerms = getSettingsList("Gating Issues");
  const nonGatingIssueTerms = getSettingsList("Non-Gating Issues");

  // Custom Area Prefix Extractor
  let areaPrefix = "";
  const areaPrefixIdx = settingsHeaders.indexOf("Area Prefix");
  if (areaPrefixIdx !== -1) {
    for (let i = 1; i < settingsData.length; i++) {
      let val = settingsData[i][areaPrefixIdx];
      if (val !== undefined && val !== "" && typeof val !== 'boolean') {
        areaPrefix = val.toString().toLowerCase();
        break;
      }
    }
  }

  const assetMatrix = readAssetMatrix_();
  if (assetMatrix.assets.size === 0) {
    SpreadsheetApp.getUi().alert("The 'Asset Matrix' tab is missing or empty — nothing to build.");
    return;
  }

  // Explicit template -> (phase, type) assignments from the Checklist
  // Type Mapping sheet. When a checklist's template has an entry here, it
  // wins over the name-substring match below — this is what makes the
  // sheet an actual "conversion table" rather than just documentation.
  const templateMapping = readChecklistTypeMapping_();

  const activeCategories = [];
  ['L2', 'L3', 'L4'].forEach(phase => {
    (assetMatrix.typesByPhase[phase] || []).forEach(label => {
      activeCategories.push({
        name: phase + ' ' + label,
        phase: phase,
        label: label,
        maxCols: 10,
        source: (phase === 'L4') ? 'Tests' : 'Checklists',
        searchTerms: [label.toLowerCase()]
      });
    });
  });

  if (activeCategories.length === 0 && issuesData.length === 0) {
    SpreadsheetApp.getUi().alert("No checklist types found in the Asset Matrix tab, and no Issues data found.");
    return;
  }

  // --- NEW: Map Duration Data ---
  let durationSheet = ss.getSheetByName("Duration");
  if (!durationSheet) {
    durationSheet = ss.insertSheet("Duration");
    durationSheet.appendRow(["Asset Types", "Duration L2", "Duration L3", "Duration L4"]);
  }
  const durationData = durationSheet.getDataRange().getValues();
  const durationMap = {};
  if (durationData.length > 1) {
    const dHeaders = durationData[0].map(h => h.toString().trim().toLowerCase());

    let tIdx = dHeaders.indexOf("asset types");
    if (tIdx === -1) tIdx = dHeaders.indexOf("asset type");

    let l2Idx = dHeaders.indexOf("duration l2");
    if (l2Idx === -1) l2Idx = dHeaders.indexOf("l2");

    let l3Idx = dHeaders.indexOf("duration l3");
    if (l3Idx === -1) l3Idx = dHeaders.indexOf("l3");

    let l4Idx = dHeaders.indexOf("duration l4");
    if (l4Idx === -1) l4Idx = dHeaders.indexOf("l4");

    if (tIdx !== -1) {
      for (let i = 1; i < durationData.length; i++) {
        let t = durationData[i][tIdx] ? durationData[i][tIdx].toString().trim().toLowerCase() : "";
        if (t) {
          durationMap[t] = {
            L2: l2Idx !== -1 ? durationData[i][l2Idx] : "",
            L3: l3Idx !== -1 ? durationData[i][l3Idx] : "",
            L4: l4Idx !== -1 ? durationData[i][l4Idx] : ""
          };
        }
      }
    }
  }

  // --- 2. Map Assets, Area, & CxAlloy IDs ---
  const equipMap = {};
  if (equipData.length > 0) {
    let eqHeaders = equipData[0].map(h => h.toString().toLowerCase().trim());

    let nameIdx = eqHeaders.indexOf("asset");
    if (nameIdx === -1) nameIdx = eqHeaders.indexOf("name");

    let areaIdx = eqHeaders.indexOf("area");
    if (areaIdx === -1) areaIdx = eqHeaders.indexOf("space");

    let projIdIdx = eqHeaders.indexOf("project_id");
    if (projIdIdx === -1) projIdIdx = eqHeaders.indexOf("project id");

    let equipIdIdx = eqHeaders.indexOf("equipment_id");
    if (equipIdIdx === -1) equipIdIdx = eqHeaders.indexOf("equipment id");
    if (equipIdIdx === -1) equipIdIdx = eqHeaders.indexOf("id");

    // NEW: Capture the type
    let typeIdx = eqHeaders.indexOf("type");
    if (typeIdx === -1) typeIdx = eqHeaders.indexOf("asset type");

    if (nameIdx !== -1) {
      for (let i = 1; i < equipData.length; i++) {
        let eqName = equipData[i][nameIdx] ? equipData[i][nameIdx].toString().trim() : "";
        let eqArea = areaIdx !== -1 && equipData[i][areaIdx] ? equipData[i][areaIdx].toString().trim() : "";
        let projId = projIdIdx !== -1 && equipData[i][projIdIdx] ? equipData[i][projIdIdx].toString().trim() : "";
        let equipId = equipIdIdx !== -1 && equipData[i][equipIdIdx] ? equipData[i][equipIdIdx].toString().trim() : "";
        let eqType = typeIdx !== -1 && equipData[i][typeIdx] ? equipData[i][typeIdx].toString().trim() : ""; // NEW

        if (eqName) {
          equipMap[eqName] = {
            Area: eqArea,
            ProjectID: projId,
            EquipmentID: equipId,
            Type: eqType // NEW
          };
        }
      }
    }
  }

  // --- 3. Parse Logic Rules (Helper Function) ---
  function parseRulesSheet(dataArray, sheetName) {
    if (!dataArray || dataArray.length < 2) return [];
    const headers = dataArray[0].map(h => h.toString().toLowerCase().trim());

    const rIdxPhase = headers.findIndex(h => h.includes("phase") && !h.includes("chk"));
    const rIdxPrev = headers.findIndex(h => h.includes("prev"));
    const rIdxGate = headers.findIndex(h => h.includes("gate cl"));
    const rIdxSupp = headers.findIndex(h => h.includes("support cl"));
    const rIdxSuppPending = headers.findIndex(h => h.includes("pend. cx") || h.includes("pending cx") || (h.includes("supp") && h.includes("pend")));
    const rIdxGating = headers.findIndex(h => h.includes("max gating") || (h.includes("gating issue") && !h.includes("non") && !h.includes("include")));
    const rIdxNonGating = headers.findIndex(h => h.includes("non-gating") || h.includes("non gating"));
    const rIdxIncCHKs = headers.findIndex(h => h.includes("include open chk"));
    const rIdxIncIssues = headers.findIndex(h => h.includes("include open gating"));
    const rIdxResult = headers.findIndex(h => h.includes("result"));

    if (rIdxResult === -1) {
      SpreadsheetApp.getUi().alert(`Error: Could not find a 'Resulting Status' header in the ${sheetName} tab.`);
      return [];
    }

    const rules = [];
    for (let r = 1; r < dataArray.length; r++) {
      if (dataArray[r][0] === true) {
        rules.push({
          phase: rIdxPhase !== -1 ? (dataArray[r][rIdxPhase] || "").toString().trim().toUpperCase() : "",
          prevCond: rIdxPrev !== -1 ? (dataArray[r][rIdxPrev] || "").toString().trim() : "",
          gateCond: rIdxGate !== -1 ? dataArray[r][rIdxGate] : "",
          supportCond: rIdxSupp !== -1 ? dataArray[r][rIdxSupp] : "",
          supportPendingCond: rIdxSuppPending !== -1 ? dataArray[r][rIdxSuppPending] : "",
          gatingIssueCond: rIdxGating !== -1 ? dataArray[r][rIdxGating] : "",
          nonGatingIssueCond: rIdxNonGating !== -1 ? dataArray[r][rIdxNonGating] : "",
          includeOpenCHKs: rIdxIncCHKs !== -1 ? dataArray[r][rIdxIncCHKs] === true : false,
          includeOpenIssues: rIdxIncIssues !== -1 ? dataArray[r][rIdxIncIssues] === true : false,
          result: rIdxResult !== -1 ? (dataArray[r][rIdxResult] || "").toString().trim() : ""
        });
      }
    }
    return rules;
  }

  // Generate both rule sets independently
  const activeRules = parseRulesSheet(rulesData, "Phase Rules");
  const activeLPRules = parseRulesSheet(lpRulesData, "Phase Rules LP");

  function evalCondition(val, condStr) {
    if (condStr === undefined || condStr === "") return true;
    let str = condStr.toString().trim().replace(/^'/, "");
    let match = str.match(/^(>=|<=|>|<|=)?\s*(\d+)$/);
    if (!match) return false;
    let op = match[1] || "<=";
    let num = parseInt(match[2], 10);

    if (op === ">") return val > num;
    if (op === "<") return val < num;
    if (op === ">=") return val >= num;
    if (op === "<=") return val <= num;
    if (op === "=") return val === num;
    return false;
  }

  function evalPrevStatus(actualStatus, condStr) {
    if (!condStr || condStr.toString().trim() === "") return true;
    let str = condStr.toString().trim();
    let lowerStr = str.toLowerCase();
    if (lowerStr === "n/a" || lowerStr === "none" || lowerStr === "-") return true;
    let isNot = str.startsWith("!");
    let target = isNot ? str.substring(1).trim().toLowerCase() : lowerStr;
    let actual = (actualStatus || "").toString().trim().toLowerCase();

    if (isNot) return !actual.includes(target);
    return actual.includes(target);
  }

  function getAssetArea(assetName) {
    let eqData = equipMap[assetName];
    if (!eqData || !eqData.Area) return "Other";

    let rawArea = eqData.Area;
    if (areaPrefix !== "") {
      let lowerArea = rawArea.toLowerCase();
      let idx = lowerArea.indexOf(areaPrefix);
      if (idx !== -1) {
        let extracted = rawArea.substring(idx + areaPrefix.length).trim();
        return extracted !== "" ? extracted : "Other";
      } else {
        return "Other";
      }
    }
    return rawArea;
  }

  // --- 4. Initialize the Asset Map ---
  // Returns false (and initializes nothing) for any asset not listed in
  // the Asset Matrix tab — every downstream loop calls initAsset() before
  // touching assetMap, so this is the allowlist enforcement point.
  const assetMap = {};
  function initAsset(equipment) {
    if (!assetMatrix.assets.has(equipment)) return false;
    if (!assetMap[equipment]) {
      assetMap[equipment] = {
        Area: getAssetArea(equipment),
        Type: equipMap[equipment] ? equipMap[equipment].Type : "",
        ProjectID: equipMap[equipment] ? equipMap[equipment].ProjectID : "",
        EquipmentID: equipMap[equipment] ? equipMap[equipment].EquipmentID : "",
        Issues: [],
        openCounts: {},
        pendingCxCounts: {},
        cxCompleteCounts: {},
        openChecklists: {},
        openGatingIssues: [],
        issueMetrics: { gatingOpen: 0, gatingClosed: 0, nonGatingOpen: 0, nonGatingClosed: 0 }
      };
      const required = assetMatrix.requirements[equipment] || {};
      activeCategories.forEach(cat => {
        // Only initialize buckets for types this specific asset actually
        // requires — a category never touched for this asset stays
        // undefined, which the Output-sheet writer reads as "leave blank."
        if (!required[cat.phase] || !required[cat.phase].has(cat.label)) return;
        assetMap[equipment][cat.name] = [];
        assetMap[equipment].openCounts[cat.name] = 0;
        assetMap[equipment].pendingCxCounts[cat.name] = 0;
        assetMap[equipment].cxCompleteCounts[cat.name] = 0;
        assetMap[equipment].openChecklists[cat.name] = [];
      });
    }
    return true;
  }

  // --- 5. Process RawData (L2 & L3) ---
  const rawHeaders = rawData[0];
  const rawIdIdx = rawHeaders.indexOf("number");
  const rawEquipIdx = rawHeaders.indexOf("asset_name");
  const rawNameIdx = rawHeaders.indexOf("name");
  const rawTemplateNameIdx = rawHeaders.indexOf("template_name");
  const rawStatusIdx = rawHeaders.indexOf("status");

  if (rawIdIdx !== -1 && rawEquipIdx !== -1 && rawNameIdx !== -1) {
    for (let j = 1; j < rawData.length; j++) {
      let id = rawData[j][rawIdIdx];
      let equipment = rawData[j][rawEquipIdx];
      let checklistName = rawData[j][rawNameIdx] ? rawData[j][rawNameIdx].toString().trim().toLowerCase() : "";
      let templateName = (rawTemplateNameIdx !== -1 && rawData[j][rawTemplateNameIdx]) ? rawData[j][rawTemplateNameIdx].toString().trim() : "";
      let status = rawStatusIdx !== -1 && rawData[j][rawStatusIdx] ? rawData[j][rawStatusIdx].toString().trim().toLowerCase() : "";

      if (equipment === "") continue;
      if (!initAsset(equipment)) continue; // not in the Asset Matrix allowlist

      // A template with an explicit row in Checklist Type Mapping wins
      // outright; otherwise fall back to matching the checklist's own
      // name text (the original technique, still useful for templates
      // nobody has mapped yet). A template whose OWN name carries an i2/i3
      // marker is explicitly NOT a Level 2/3/4 item (confirmed distinct
      // from L2/L3), so it's excluded from every Checklists category
      // outright — it must never fall through to the name-substring
      // guess, which doesn't know about that distinction and could
      // wrongly pull it into a Level column anyway.
      const mappedEntries = templateName ? (templateMapping[templateName] || null) : null;
      const templatePhaseMarker = templateName ? detectTemplatePhaseMarker_(templateName) : null;
      const isNonLevelTemplate = !!templatePhaseMarker && templatePhaseMarker.charAt(0) === 'I';

      activeCategories.forEach(cat => {
        if (cat.source !== "Checklists") return;
        if (!assetMap[equipment][cat.name]) return; // not required for this asset
        if (isNonLevelTemplate) return; // i2/i3-marked template — not a Level 2/3/4 item
        const matches = mappedEntries
          ? mappedEntries.some(m => m.phase === cat.phase && m.label.toLowerCase() === cat.label.toLowerCase())
          : cat.searchTerms.some(term => checklistName.includes(term));
        if (!matches) return;

        assetMap[equipment][cat.name].push(id);
        if (checklistOpenStatuses.includes(status)) {
          assetMap[equipment].openCounts[cat.name]++;
          assetMap[equipment].openChecklists[cat.name].push(id);
        } else if (checklistClosedStatuses.includes(status) && !checklistCxCompleteStatuses.includes(status)) {
          assetMap[equipment].pendingCxCounts[cat.name]++;
        } else if (checklistCxCompleteStatuses.includes(status)) {
          assetMap[equipment].cxCompleteCounts[cat.name]++;
        }
      });
    }
  }

  // --- 6. Process Tests Data (L4) ---
  if (testsData.length > 0) {
    const testHeaders = testsData[0];
    const testIdIdx = testHeaders.indexOf("number");
    const testEquipIdx = testHeaders.indexOf("asset_name");
    const testNameIdx = testHeaders.indexOf("name");
    const testStatusIdx = testHeaders.indexOf("status");

    if (testIdIdx !== -1 && testEquipIdx !== -1 && testNameIdx !== -1) {
      for (let k = 1; k < testsData.length; k++) {
        let id = testsData[k][testIdIdx];
        let equipment = testsData[k][testEquipIdx];
        let nameStr = testsData[k][testNameIdx] ? testsData[k][testNameIdx].toString().toLowerCase() : "";
        let status = testStatusIdx !== -1 && testsData[k][testStatusIdx] ? testsData[k][testStatusIdx].toString().trim().toLowerCase() : "";

        if (equipment === "") continue;
        if (!initAsset(equipment)) continue; // not in the Asset Matrix allowlist

        activeCategories.forEach(cat => {
          if (cat.source !== "Tests") return;
          if (!assetMap[equipment][cat.name]) return; // not required for this asset
          if (!cat.searchTerms.some(term => nameStr.includes(term))) return;

          assetMap[equipment][cat.name].push(id);
          if (testOpenStatuses.includes(status)) {
            assetMap[equipment].openCounts[cat.name]++;
            assetMap[equipment].openChecklists[cat.name].push(id);
          }
        });
      }
    }
  }

  // --- 7. Process Issues Data ---
  let maxIssues = 0;
  if (issuesData.length > 0) {
    const issueHeaders = issuesData[0];
    const issueIdIdx = issueHeaders.indexOf("name");
    const issueEquipIdx = issueHeaders.indexOf("asset_name");
    const issuePriorityIdx = issueHeaders.indexOf("priority");
    const issueStatusIdx = issueHeaders.indexOf("status");

    if (issueIdIdx !== -1 && issueEquipIdx !== -1) {
      for (let x = 1; x < issuesData.length; x++) {
        let id = issuesData[x][issueIdIdx];
        let equipment = issuesData[x][issueEquipIdx];

        let priorityStr = issuePriorityIdx !== -1 && issuesData[x][issuePriorityIdx] ? issuesData[x][issuePriorityIdx].toString().toLowerCase().trim() : "";
        let statusStr = issueStatusIdx !== -1 && issuesData[x][issueStatusIdx] ? issuesData[x][issueStatusIdx].toString().toLowerCase().trim() : "";

        if (equipment === "") continue;
        if (!initAsset(equipment)) continue; // not in the Asset Matrix allowlist

        assetMap[equipment].Issues.push(id);

        let isGating = gatingIssueTerms.some(term => priorityStr.includes(term));
        let isNonGating = nonGatingIssueTerms.some(term => priorityStr.includes(term));
        let isOpen = issueOpenStatuses.includes(statusStr);
        let isClosed = issueClosedStatuses.includes(statusStr);

        if (isGating && isOpen) {
          assetMap[equipment].issueMetrics.gatingOpen++;
          assetMap[equipment].openGatingIssues.push(id);
        }
        if (isGating && isClosed) assetMap[equipment].issueMetrics.gatingClosed++;
        if (isNonGating && isOpen) assetMap[equipment].issueMetrics.nonGatingOpen++;
        if (isNonGating && isClosed) assetMap[equipment].issueMetrics.nonGatingClosed++;
      }
    }
  }

  for (let asset in assetMap) {
    if (assetMap[asset].Issues.length > maxIssues) maxIssues = assetMap[asset].Issues.length;
  }

  // --- 8. Evaluate Statuses Sequentially ---
  // Updated to dynamically accept the chosen ruleSet
  function determinePhaseStatus(phase, assetData, prevStatusTextOnly, ruleSet) {
    // "Tag" is the Gate checklist; every OTHER required type for this
    // asset at this phase aggregates into the Support total — same split
    // the original Gate/Support model had, just now driven by which types
    // the Asset Matrix says this asset actually needs. Matches the
    // original behavior of Gate never being pendingCx-checked (only
    // Support was).
    let gateCount = 0, supportCount = 0, pendingCxCount = 0;
    activeCategories.forEach(cat => {
      if (cat.phase !== phase) return;
      if (assetData.openCounts[cat.name] === undefined) return; // not required for this asset
      if (cat.label.toLowerCase() === 'tag') {
        gateCount += assetData.openCounts[cat.name] || 0;
      } else {
        supportCount += assetData.openCounts[cat.name] || 0;
        pendingCxCount += assetData.pendingCxCounts[cat.name] || 0;
      }
    });
    let gatingIssueCount = assetData.issueMetrics.gatingOpen;
    let nonGatingIssueCount = assetData.issueMetrics.nonGatingOpen;

    let phaseRules = ruleSet.filter(r => r.phase === phase);

    for (let i = 0; i < phaseRules.length; i++) {
      let r = phaseRules[i];
      if (
        evalPrevStatus(prevStatusTextOnly, r.prevCond) &&
        evalCondition(gateCount, r.gateCond) &&
        evalCondition(supportCount, r.supportCond) &&
        evalCondition(pendingCxCount, r.supportPendingCond) &&
        evalCondition(gatingIssueCount, r.gatingIssueCond) &&
        evalCondition(nonGatingIssueCount, r.nonGatingIssueCond)
      ) {

        let rawResult = r.result;
        let details = [];

        if (r.includeOpenCHKs) {
          let phaseOpenCLs = [];
          activeCategories.forEach(cat => {
            if (cat.phase !== phase) return;
            if (cat.label.toLowerCase() === 'tag') return; // Support-only detail list, matches the original Gate/Support behavior
            if (assetData.openChecklists[cat.name]) phaseOpenCLs = phaseOpenCLs.concat(assetData.openChecklists[cat.name]);
          });
          if (phaseOpenCLs.length > 0) details.push("Open CHK(s): " + phaseOpenCLs.join(", "));
        }

        if (r.includeOpenIssues) {
          if (assetData.openGatingIssues.length > 0) {
            details.push("Open Gating Issue(s): " + assetData.openGatingIssues.join(", "));
          }
        }

        let itemsStr = details.length > 0 ? details.join(" | ") : "";

        if (itemsStr !== "") {
          if (rawResult.endsWith("-") || rawResult.endsWith(":")) {
            return rawResult + " " + itemsStr;
          } else {
            return rawResult + "" + itemsStr;
          }
        }

        return rawResult;
      }
    }
    return "No Rule Matched / N/A";
  }

  function buildHyperlinkStatus(assetData, statusText) {
    if (assetData.ProjectID && assetData.EquipmentID) {
      let url = `https://google.cxalloy.com/project/${assetData.ProjectID}/equipment/${assetData.EquipmentID}`;
      let safeText = statusText.replace(/"/g, '""');
      return `=HYPERLINK("${url}", "${safeText}")`;
    }
    return statusText;
  }

  // --- 9. Build Headers ---
  const outHeaders = ["Asset", "Area"];
  const countHeaders = ["Asset", "Area"];
  const lpDataHeaders = ["Phase", "Asset", "Status", "Duration"]; // NEW: Added Duration
  const phases = ["L2", "L3", "L4"];

  phases.forEach(phase => {
    const phaseCats = activeCategories.filter(c => c.phase === phase);
    phaseCats.forEach(cat => {
      for (let c = 1; c <= cat.maxCols; c++) outHeaders.push(cat.name + " CL " + c);
      countHeaders.push(cat.name + " Open");
    });

    if (phaseCats.length > 0) outHeaders.push(phase + " Overall Status");
  });

  for (let i = 1; i <= maxIssues; i++) outHeaders.push("Issue " + i);

  countHeaders.push("Gating Issues Open", "Gating Issues Closed", "Non-Gating Issues Open", "Non-Gating Issues Closed");
  countHeaders.push("L2 Overall Status", "L3 Overall Status", "L4 Overall Status");

  const outputData = [outHeaders];
  const countData = [countHeaders];
  const lpData = [lpDataHeaders];

  // --- 10. Build Rows ---
  for (let asset in assetMap) {
    let assetData = assetMap[asset];
    let rowOut = [asset, assetData.Area];
    let rowCount = [asset, assetData.Area];
    let hasData = false;

    // Evaluate main Output Sheet statuses using `activeRules`
    let l2RawStatus = determinePhaseStatus("L2", assetData, "", activeRules);
    let l3RawStatus = determinePhaseStatus("L3", assetData, l2RawStatus, activeRules);
    let l4RawStatus = determinePhaseStatus("L4", assetData, l3RawStatus, activeRules);

    let l2Linked = buildHyperlinkStatus(assetData, l2RawStatus);
    let l3Linked = buildHyperlinkStatus(assetData, l3RawStatus);
    let l4Linked = buildHyperlinkStatus(assetData, l4RawStatus);
    let statusMap = { "L2": l2Linked, "L3": l3Linked, "L4": l4Linked };

    // Evaluate LP_Data Sheet statuses using `activeLPRules`
    let l2LPRawStatus = determinePhaseStatus("L2", assetData, "", activeLPRules);
    let l3LPRawStatus = determinePhaseStatus("L3", assetData, l2LPRawStatus, activeLPRules);
    let l4LPRawStatus = determinePhaseStatus("L4", assetData, l3LPRawStatus, activeLPRules);

    let l2LPLinked = buildHyperlinkStatus(assetData, l2LPRawStatus);
    let l3LPLinked = buildHyperlinkStatus(assetData, l3LPRawStatus);
    let l4LPLinked = buildHyperlinkStatus(assetData, l4LPRawStatus);

    phases.forEach(phase => {
      const phaseCats = activeCategories.filter(c => c.phase === phase);
      phaseCats.forEach(cat => {
        const checklists = assetData[cat.name]; // undefined = not required for this asset
        if (checklists === undefined) {
          // Not required for this asset — every cell in this type's
          // column group, and its Open count, stays genuinely blank.
          for (let c = 1; c <= cat.maxCols; c++) rowOut.push("");
          rowCount.push("");
          return;
        }
        if (checklists.length > 0) hasData = true;
        let clSlice = checklists.slice(0, cat.maxCols);
        while (clSlice.length < cat.maxCols) clSlice.push("");
        rowOut = rowOut.concat(clSlice);
        rowCount.push(assetData.openCounts[cat.name]);
      });

      if (phaseCats.length > 0) rowOut.push(statusMap[phase]);
    });

    let issuesList = assetData.Issues;
    if (issuesList.length > 0) hasData = true;

    let issueSlice = issuesList.slice();
    while (issueSlice.length < maxIssues) issueSlice.push("");
    rowOut = rowOut.concat(issueSlice);

    rowCount.push(
      assetData.issueMetrics.gatingOpen,
      assetData.issueMetrics.gatingClosed,
      assetData.issueMetrics.nonGatingOpen,
      assetData.issueMetrics.nonGatingClosed
    );

    rowCount.push(l2Linked, l3Linked, l4Linked);

    if (hasData) {
      let assetType = assetData.Type ? assetData.Type.toLowerCase() : "";

      // 🟢 THE FIX: Append "hours" when writing directly to the LP_Data sheet
      let durL2 = durationMap[assetType] && durationMap[assetType].L2 !== "" ? durationMap[assetType].L2 + " hours" : "";
      let durL3 = durationMap[assetType] && durationMap[assetType].L3 !== "" ? durationMap[assetType].L3 + " hours" : "";
      let durL4 = durationMap[assetType] && durationMap[assetType].L4 !== "" ? durationMap[assetType].L4 + " hours" : "";

      outputData.push(rowOut);
      countData.push(rowCount);
      lpData.push(["Level 2", asset, l2LPLinked, durL2]);
      lpData.push(["Level 3", asset, l3LPLinked, durL3]);
      lpData.push(["Level 4", asset, l4LPLinked, durL4]);
    }
  }

  // --- 11. Write to Sheets ---
  outputSheet.clear();
  countsSheet.clear();
  lpDataSheet.clear();

  if (outputData.length > 1) {
    outputSheet.getRange(1, 1, outputData.length, outputData[0].length).setValues(outputData);
    outputSheet.getRange(1, 1, 1, outputData[0].length).setFontWeight("bold");

    countsSheet.getRange(1, 1, countData.length, countData[0].length).setValues(countData);
    countsSheet.getRange(1, 1, 1, countData[0].length).setFontWeight("bold");

    lpDataSheet.getRange(1, 1, lpData.length, lpData[0].length).setValues(lpData);
    lpDataSheet.getRange(1, 1, 1, lpData[0].length).setFontWeight("bold");
  } else {
    outputSheet.getRange("A1").setValue("No data found.");
    countsSheet.getRange("A1").setValue("No data found.");
    lpDataSheet.getRange("A1").setValue("No data found.");
  }
}

// Helper function to format the output as JSON for your Web App
function returnJSON(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function forceAuth() {
  MailApp.sendEmail(Session.getActiveUser().getEmail(), "Permission Test", "Testing...");
}

function getExternalData() {
    // 1. REPLACE with the ID of your OTHER spreadsheet (found in the URL)
    const EXTERNAL_SS_ID = '1ErT5c3mL9tkbBXaIkgGDQ5xDHSNKCSs0dm5vdowb9WM';
    const ss = SpreadsheetApp.openById(EXTERNAL_SS_ID);

    // 2. Define which sheets (tabs) you want to pull from
    const sheetsToPull = ['Equipment', 'Checklists', 'Tests','Issues']; // Example tab names
    const results = {};

    sheetsToPull.forEach(name => {
        const sheet = ss.getSheetByName(name);
        if (sheet) {
            // Option A: Just get a count of rows
            const rowCount = sheet.getLastRow() - 1;

            // Option B: Get a specific summary value (e.g., from cell B1)
            const summaryValue = sheet.getRange('B1').getValue();

            results[name] = {
                count: rowCount > 0 ? rowCount : 0,
                summary: summaryValue
            };
        }
    });

    return ContentService.createTextOutput(JSON.stringify(results))
        .setMimeType(ContentService.MimeType.JSON);
}

function combineColumnsWithPrefix() {
  // 1. Get the active spreadsheet and sheet
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  // 2. Define your table boundaries and columns (Adjust these to match your table!)
  var startRow = 2;          // The row where your data starts (e.g., row 2 if row 1 has headers)
  var colA = 14;              // Column number for the first text (1 = Column A)
  var colB = 12;              // Column number for the second text (2 = Column B)
  var targetCol = 12;         // Column number where you want the result (3 = Column C)
  var prefix = "Area ";        // The prefix text you want to add

  // 3. Find the last row with data based on your first column
  var lastRow = sheet.getLastRow();

  // Prevent the script from running if the sheet is empty
  if (lastRow < startRow) {
    Logger.log("No data found to process.");
    return;
  }

  // 4. Calculate how many rows to process
  var numRows = lastRow - startRow + 1;

  // 5. Get data from Column A and Column B in bulk (highly efficient)
  var dataA = sheet.getRange(startRow, colA, numRows, 1).getValues();
  var dataB = sheet.getRange(startRow, colB, numRows, 1).getValues();

  // 6. Create an empty array to hold the newly combined results
  var outputValues = [];

  // 7. Loop through the rows and combine the text
  for (var i = 0; i < numRows; i++) {
    var valA = dataA[i][0];
    var valB = dataB[i][0];

    // Combine prefix + Column A + Column B (with an optional space/separator in between)
    var combinedText = prefix + valA + " " + valB;

    // Push the result as a row array into our output array
    outputValues.push([combinedText]);
  }

  // 8. Write all the combined values back to the target column at once
  sheet.getRange(startRow, targetCol, numRows, 1).setValues(outputValues);
}


/**
 * Extracts text between '=' and ',' from a specific column and outputs it to another column.
 */
function ifareaserved() {
  // --- CONFIGURATION ---
  const SHEET_NAME = "Equipment"; // Change to your actual sheet name
  const TARGET_COLUMN = 22;            // Column to read (1 = Column A, 2 = Column B, etc.)
  const OUTPUT_COLUMN = 24;            // Column to write results (2 = Column B)
  const START_ROW = 2;                // Row to start processing (1 = Row 1, 2 = Row 2 if you have headers)
  // ---------------------

  // Get active spreadsheet and the defined sheet
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    throw new Error(`Sheet with name "${SHEET_NAME}" was not found.`);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < START_ROW) {
    Logger.log("No data found to process.");
    return;
  }

  const numRows = lastRow - START_ROW + 1;

  // Retrieve data in bulk for fast performance
  const sourceRange = sheet.getRange(START_ROW, TARGET_COLUMN, numRows, 1);
  const sourceValues = sourceRange.getValues();
  const outputValues = [];

  // Regex extracts everything between '=' and ',' (or end of line)
  const regex = /name=(.*?)(?:,|$)/;

  // Process the column row by row
  for (let i = 0; i < sourceValues.length; i++) {
    const cellValue = String(sourceValues[i]).trim();

    // Check if the original source cell is completely empty
    if (cellValue === "") {
      outputValues.push(["Other"]);
      continue;
    }

    const match = cellValue.match(regex);

    if (match && match[1]) {
      // 1. Get the match and remove leading/trailing whitespace
      let extractedText = match[1].trim();

      // 2. Trim trailing '}' characters if they exist
      extractedText = extractedText.replace(/}+$/, "").trim();

      // 3. If trimming left it empty, default to "Other", otherwise push the text
      outputValues.push([extractedText === "" ? "Other" : extractedText]);
    } else {
      // If the cell had text but didn't contain the '=' delimiter
      outputValues.push(["Other"]);
    }
  }

  // Write all results back to the sheet in a single batch
  const outputRange = sheet.getRange(START_ROW, OUTPUT_COLUMN, numRows, 1);
  outputRange.setValues(outputValues);

  Logger.log(`Successfully processed and cleaned ${numRows} rows.`);
}

function moveColumnData() {
  // Get the active sheet
  const SHEET_NAME = "Equipment"; // Change to your actual sheet name

  // Get active spreadsheet and the defined sheet
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);

  // Define source range (Column A, rows 1 to the last row with data)
  const lastRow = sheet.getLastRow();
  if (lastRow === 0) return; // Exit if the sheet is empty

  const sourceRange = sheet.getRange(2, 24, lastRow, 1); // (startRow, startColumn, numRows, numColumns)

  // Define destination range (Column C, starting at row 1)
  const targetRange = sheet.getRange(2, 12); // (row, column)

  // Move the data and clear the source range
  sourceRange.moveTo(targetRange);
}

function forceDriveAuth() {
  DriveApp.getRootFolder();
}

function buildDashboardJson_(projectIdParam) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const projectId = projectIdParam ? String(projectIdParam).trim() : '';

  // ---- generic sheet -> array-of-objects reader (case/whitespace-insensitive headers) ----
  function readSheet_(name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) return { headers: [], rows: [] };
    const data = sheet.getDataRange().getDisplayValues();
    if (data.length < 2) return { headers: [], rows: [] };
    const headers = data[0].map(h => String(h).trim().toLowerCase());
    return { headers: headers, rows: data.slice(1) };
  }
  function col_(headers, row, ...names) {
    for (const n of names) {
      const idx = headers.indexOf(n.toLowerCase());
      if (idx > -1) {
        const v = row[idx];
        return (v === '' || v === undefined) ? null : v;
      }
    }
    return null;
  }

  // ---- Projects tab: resolve project_id -> project_name ----
  let resolvedProjectId = projectId;
  let projectName = '';
  const projSheet = readSheet_('Projects');
  if (projSheet.rows.length) {
    let match = projSheet.rows.find(r =>
      String(col_(projSheet.headers, r, 'project_id')) === projectId);
    if (!match && !projectId) match = projSheet.rows[0];
    if (match) {
      resolvedProjectId = col_(projSheet.headers, match, 'project_id') || projectId;
      projectName = col_(projSheet.headers, match, 'name') || '';
    }
  }

  // ---- Attributes tab: Asset Name -> Building Phase lookup ----
  const attrSheet = readSheet_('Attributes');
  const buildingPhaseByAsset = {};
  if (attrSheet.rows.length) {
    for (const r of attrSheet.rows) {
      const assetName = col_(attrSheet.headers, r, 'asset name');
      const phase = col_(attrSheet.headers, r, 'building phase');
      if (assetName && phase) buildingPhaseByAsset[String(assetName).trim()] = phase;
    }
  }

  // ---- Equipment ----
  const eqSheet = readSheet_('Equipment');
  const equipment = eqSheet.rows
    .filter(r => col_(eqSheet.headers, r, 'equipment_id'))
    .map(r => {
      const name = col_(eqSheet.headers, r, 'name');
      const floor = col_(eqSheet.headers, r, 'floor');
      return {
        equipment_id: String(col_(eqSheet.headers, r, 'equipment_id')),
        name: name,
        type: col_(eqSheet.headers, r, 'type'),
        discipline: col_(eqSheet.headers, r, 'discipline'),
        status: col_(eqSheet.headers, r, 'status'),
        space: col_(eqSheet.headers, r, 'space'),
        building_phase: (name && buildingPhaseByAsset[String(name).trim()]) || 'Unknown',
        floor_parsed: floor || 'Unknown'
      };
    });

  // ---- Issues ----
  function agingCategory_(days) {
    if (days === null) return null;
    if (days < 45) return 'Under 45 Days';
    if (days <= 90) return '45-90 Days';
    return 'Over 90 Days';
  }
  function daysOpen_(dateCreated, dateClosed) {
    if (!dateCreated) return null;
    const start = new Date(dateCreated);
    if (isNaN(start)) return null;
    const end = dateClosed ? new Date(dateClosed) : new Date();
    if (isNaN(end)) return null;
    return Math.max(0, Math.round((end - start) / 86400000));
  }
  const issueSheet = readSheet_('Issues');
  const issues = issueSheet.rows
    .filter(r => col_(issueSheet.headers, r, 'issue_id'))
    .map(r => {
      const dateCreated = col_(issueSheet.headers, r, 'date_created');
      const dateClosed = col_(issueSheet.headers, r, 'date_closed', 'closed_date');
      const days = daysOpen_(dateCreated, dateClosed);
      const assignedName = col_(issueSheet.headers, r, 'assigned_name');
      return {
        name: col_(issueSheet.headers, r, 'name'),
        description: col_(issueSheet.headers, r, 'description'),
        status: col_(issueSheet.headers, r, 'status'),
        priority: col_(issueSheet.headers, r, 'priority'),
        discipline: col_(issueSheet.headers, r, 'discipline'),
        assigned_company: assignedName,
        assigned_name: assignedName,
        aging_category: agingCategory_(days),
        days_open: days,
        date_created: dateCreated,
        in_progress_date: col_(issueSheet.headers, r, 'in_progress_date'),
        date_closed: dateClosed,
        asset_key: col_(issueSheet.headers, r, 'asset_key')
      };
    });

  // ---- Checklists ----
  function levelFromTypeName_(typeName) {
    if (!typeName) return 'L1';
    const s = String(typeName);
    let m = s.match(/^L(\d)/i);
    if (m) return 'L' + m[1];
    m = s.match(/Level\s*(\d)/i);
    if (m) return 'L' + m[1];
    if (/pre-?functional/i.test(s)) return 'L1';
    return 'L1';
  }
  const clSheet = readSheet_('Checklists');
  const checklists = clSheet.rows
    .filter(r => col_(clSheet.headers, r, 'checklist_id'))
    .map(r => {
      const typeName = col_(clSheet.headers, r, 'type_name');
      return {
        level: levelFromTypeName_(typeName),
        status: col_(clSheet.headers, r, 'status'),
        discipline: col_(clSheet.headers, r, 'discipline'),
        assigned_company: col_(clSheet.headers, r, 'assigned_name'),
        assigned_type: col_(clSheet.headers, r, 'assigned_type'),
        asset_key: col_(clSheet.headers, r, 'asset_key'),
        type_name: typeName
      };
    });

  // ---- Tests ----
  const testSheet = readSheet_('Tests');
  const tests = testSheet.rows
    .filter(r => col_(testSheet.headers, r, 'test_id'))
    .map(r => {
      const assignedName = col_(testSheet.headers, r, 'assigned_name');
      return {
        name: col_(testSheet.headers, r, 'name'),
        status: col_(testSheet.headers, r, 'status'),
        assigned_company: assignedName,
        assigned_name: assignedName,
        discipline: col_(testSheet.headers, r, 'discipline'),
        attempt_count: col_(testSheet.headers, r, 'attempt_count'),
        asset_name: col_(testSheet.headers, r, 'asset_name'),
        asset_key: col_(testSheet.headers, r, 'asset_key')
      };
    });

  // ---- Companies: unique assigned_name where assigned_type = company, across CL + Tests ----
  const companySet = {};
  [[clSheet, checklists.length], [testSheet, tests.length]].forEach(() => {});
  function collectCompanies_(sheetObj) {
    sheetObj.rows.forEach(r => {
      const type = col_(sheetObj.headers, r, 'assigned_type');
      const name = col_(sheetObj.headers, r, 'assigned_name');
      if (name && String(type).toLowerCase() === 'company') {
        companySet[String(name).trim()] = true;
      }
    });
  }
  collectCompanies_(clSheet);
  collectCompanies_(testSheet);
  const companies = Object.keys(companySet).sort().map(name => ({ name: name }));

  const result = {
    project_id: resolvedProjectId,
    project_name: projectName,
    data_synced_at: new Date().toISOString(),
    issues: issues,
    checklists: checklists,
    tests: tests,
    equipment: equipment,
    companies: companies
  };

  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function fetchAndUpdateCxAlloySettings(projectId = 45) {
  console.log("Fetching CxAlloy Settings Data using global credentials...");

  var baseUrl = 'https://google.cxalloy.com/api/v1';

  // Helper function to call endpoints using global keys directly
  function fetchSettingsEndpoint(endpoint) {
    var url = baseUrl + endpoint + '?project_id=' + projectId;
    var timestamp = Math.floor(new Date().getTime() / 1000).toString();

    // Automatically uses the global secret and identifier from the top of your script
    var signature = generateHmacSignature(timestamp, CXALLOY_SECRET);

    var options = {
      'method': 'get',
      'headers': {
        'cache-control': 'no-cache',
        'content-type': 'application/json',
        'cxalloy-identifier': CXALLOY_IDENTIFIER,
        'cxalloy-signature': signature,
        'cxalloy-timestamp': timestamp
      },
      'muteHttpExceptions': true
    };

    var response = UrlFetchApp.fetch(url, options);
    var statusCode = response.getResponseCode();
    var responseText = response.getContentText();

    if (statusCode !== 200) {
      console.error('API Error on ' + endpoint + ': HTTP ' + statusCode + ' - ' + responseText);
      return [];
    }

    var parsed = JSON.parse(responseText);
    return Array.isArray(parsed) ? parsed : (parsed.records || parsed.data || []);
  }

  // Fetch from the 4 specified endpoints
  var checklistStatuses = fetchSettingsEndpoint('/checkliststatus');
  var checklistTypes    = fetchSettingsEndpoint('/checklisttype');
  var issueStatuses     = fetchSettingsEndpoint('/issuestatus');
  var priorities        = fetchSettingsEndpoint('/priority');

  var combinedSettings = [];

  // Find the longest array so we know how many rows to create
  var maxLength = Math.max(
    checklistStatuses.length,
    checklistTypes.length,
    issueStatuses.length,
    priorities.length
  );

  // Build the data row by row, placing the settings side-by-side in columns
  for (var i = 0; i < maxLength; i++) {
    var cls = checklistStatuses[i] || {};
    var clt = checklistTypes[i] || {};
    var iss = issueStatuses[i] || {};
    var pri = priorities[i] || {};

    combinedSettings.push({
      "Checklist Status ID": cls.checklistsectionstatus_id || cls.id || "",
      "Checklist Status Name": cls.name || "",
      "Checklist Status Color": cls.color || "",

      "Checklist Type ID": clt.checklisttype_id || clt.id || "",
      "Checklist Type Name": clt.name || "",

      "Issue Status ID": iss.issuestatus_id || iss.id || "",
      "Issue Status Name": iss.name || "",
      "Issue Status Color": iss.color || "",

      "Issue Priority ID": pri.issuepriority_id || pri.id || "",
      "Issue Priority Name": pri.name || "",
      "Issue Priority Color": pri.color || ""
    });
  }

  console.log("Updating 'CxAlloy Settings' sheet with side-by-side columns...");
  populateSheetWithData('CxAlloy Settings', combinedSettings);
}

function readFilteredSheet_(sheetName, params) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return { status: 'error', error: 'Sheet "' + sheetName + '" not found' };

  const data = sheet.getDataRange().getDisplayValues();
  if (data.length < 2) return { status: 'success', data: [] };

  const headers = data[0].map(function (h) { return String(h).trim(); });
  const headerIdx = {};
  headers.forEach(function (h, i) { if (h) headerIdx[h.toLowerCase()] = i; });

  // Build column filters from any query param that matches a real column name.
  const filters = {};
  Object.keys(params || {}).forEach(function (key) {
    if (key === 'action') return;
    const idx = headerIdx[key.toLowerCase()];
    if (idx === undefined) return;
    const values = String(params[key]).split(',').map(function (v) { return v.trim().toLowerCase(); }).filter(Boolean);
    if (values.length) filters[idx] = values;
  });

  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row.every(function (v) { return v === ''; })) continue; // skip fully-blank rows

    let ok = true;
    for (const idx in filters) {
      const cell = String(row[idx] || '').trim().toLowerCase();
      if (filters[idx].indexOf(cell) === -1) { ok = false; break; }
    }
    if (!ok) continue;

    const obj = {};
    headers.forEach(function (h, idx) { if (h) obj[h] = row[idx]; });
    rows.push(obj);
  }
  return { status: 'success', data: rows };
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fetchAndUpdatePeopleData(projectId = 45) {
  console.log("Fetching Data");
  var personApiUrl = 'https://google.cxalloy.com/api/v1/person';
  var allPeopleData = fetchPaginatedData(personApiUrl + '?project_id=' + projectId);

  console.log("Modifying Person data to build a flat Name/Company sheet");
  var simplifiedPeopleData = allPeopleData.map(function (p) {
    var name = ((p.first_name || '') + ' ' + (p.last_name || '')).trim();
    return { "Name": name, "Company": p.company || '' };
  });

  console.log("Updating Data");
  populateSheetWithData('People', simplifiedPeopleData);
}
