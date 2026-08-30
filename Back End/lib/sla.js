'use strict';
/* =====================================================================
   SLA / ESCALATION constants — ported from the original client logic.

   Response/resolution timelines are driven by severity: the more severe
   the problem, the shorter the deadline. Each escalation level tightens
   the remaining time further. Base seconds below are a COMPRESSED DEMO
   SCALE (seconds stand in for hours/days) so the escalation sweep can be
   demonstrated live — see SEVERITY_SLA_LABEL for the real-world targets
   shown to citizens/officers. To run this in production with real
   hours/days, change SEVERITY_SLA units from seconds to the real unit
   and adjust the sweep interval in server.js accordingly.
   ===================================================================== */

const SEVERITY_SLA = {
  Critical: { resp: 20, res: 45 },
  High: { resp: 40, res: 80 },
  Medium: { resp: 70, res: 130 },
  Low: { resp: 100, res: 190 },
};

const LEVEL_TIGHTEN = [1, 0.7, 0.5];
const SEVERITY_RANK = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const SEVERITY_SLA_LABEL = {
  Critical: { resp: '2 hours', res: '8 hours' },
  High: { resp: '8 hours', res: '24 hours' },
  Medium: { resp: '24 hours', res: '3 days' },
  Low: { resp: '48 hours', res: '7 days' },
};
const LEVEL_NAMES = ['Ward / Local Officer', 'District Officer', 'State Officer'];

function slaLabel(severity, kind) {
  return (SEVERITY_SLA_LABEL[severity] && SEVERITY_SLA_LABEL[severity][kind]) || '—';
}

function computeDeadlines(severity, level) {
  const sla = SEVERITY_SLA[severity] || SEVERITY_SLA.Low;
  const tighten = LEVEL_TIGHTEN[level] ?? 1;
  const now = Date.now();
  return {
    response_deadline: now + sla.resp * 1000 * tighten,
    resolution_deadline: now + sla.res * 1000 * tighten,
  };
}

module.exports = {
  SEVERITY_SLA,
  LEVEL_TIGHTEN,
  SEVERITY_RANK,
  SEVERITY_SLA_LABEL,
  LEVEL_NAMES,
  slaLabel,
  computeDeadlines,
};
