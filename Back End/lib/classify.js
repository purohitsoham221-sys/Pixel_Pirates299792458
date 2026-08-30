'use strict';
/* =====================================================================
   CLASSIFIER — ported from the original client-side nlp.js logic.
   This is the AUTHORITATIVE copy: the server always re-classifies a
   complaint itself rather than trusting anything the client sends, so
   a tampered client can never assign its own department/severity.
   ===================================================================== */

const CATEGORY_TO_DEPARTMENT = {
  'Roads & Infrastructure': 'Public Works (Roads)',
  'Water Supply': 'Water Supply Board',
  'Electricity': 'Electricity Board',
  'Sanitation & Garbage': 'Municipal Sanitation',
  'Street Lighting': 'Electricity Board',
  'Public Health': 'Health Department',
  'Public Safety': 'Police / Public Safety',
  'Corruption / Misconduct': 'Vigilance / Anti-Corruption',
  Other: 'General Administration',
};

const DEPARTMENTS = [...new Set(Object.values(CATEGORY_TO_DEPARTMENT))];

function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

const HIGH_SEV = [
  'accident', 'fire', 'collapse', 'collapsed', 'spark', 'sparking', 'electrocut',
  'life', 'death', 'died', 'danger', 'dangerous', 'hazard', 'outbreak', 'disease',
  'attack', 'unsafe', 'children', 'school', 'hospital', 'bribe', 'gas leak',
  'exposed wire', 'live wire', 'flood', 'drowning', 'emergency',
];
const MED_SEV = [
  'weeks', 'days', 'overflow', 'leak', 'leaking', 'broken', 'not working',
  'no water', 'no power', 'outage', 'garbage', 'smell', 'mosquito',
];
const CATEGORY_KEYWORDS = {
  'Roads & Infrastructure': ['pothole', 'sadak', 'footpath', 'gaddha', 'speed breaker', 'road collapse', 'road is broken', 'broken road', 'cracked road', 'damaged road'],
  'Water Supply': ['water', 'paani', 'pipeline', 'tanker', 'tap', 'drinking water'],
  Electricity: ['power', 'electric', 'bijli', 'transformer', 'wire', 'voltage', 'current'],
  'Sanitation & Garbage': ['garbage', 'kachra', 'drain', 'drainage', 'sewage', 'toilet', 'waste'],
  'Street Lighting': ['street light', 'streetlight', 'lamp post', 'street lamp'],
  'Public Health': ['hospital', 'clinic', 'doctor', 'disease', 'dengue', 'mosquito', 'adulterat'],
  'Public Safety': ['traffic', 'signal', 'fire', 'unsafe', 'attack', 'stray dog', 'eve teasing', 'harassment'],
  'Corruption / Misconduct': ['bribe', 'corrupt', 'illegal money', 'demanding money'],
};

function keywordVote(textLower) {
  const scores = {};
  for (const c in CATEGORY_KEYWORDS) scores[c] = 0;
  for (const cat in CATEGORY_KEYWORDS) {
    for (const kw of CATEGORY_KEYWORDS[cat]) if (textLower.includes(kw)) scores[cat]++;
  }
  const top = Math.max(...Object.values(scores));
  if (top === 0) return null;
  return Object.keys(scores).find((c) => scores[c] === top);
}

function severityOf(textLower) {
  let score = 0;
  for (const kw of HIGH_SEV) if (textLower.includes(kw)) score += 3;
  for (const kw of MED_SEV) if (textLower.includes(kw)) score += 1;
  if (score >= 5) return 'Critical';
  if (score >= 3) return 'High';
  if (score >= 1) return 'Medium';
  return 'Low';
}

function classify(text) {
  const textLower = String(text || '').toLowerCase();
  const kwCat = keywordVote(textLower);
  const finalCategory = kwCat || 'Other';
  const severity = severityOf(textLower);
  return {
    category: finalCategory,
    department: CATEGORY_TO_DEPARTMENT[finalCategory],
    severity,
    needs_human_review: !kwCat,
  };
}

module.exports = {
  CATEGORY_TO_DEPARTMENT,
  DEPARTMENTS,
  CATEGORY_KEYWORDS,
  slug,
  classify,
};
