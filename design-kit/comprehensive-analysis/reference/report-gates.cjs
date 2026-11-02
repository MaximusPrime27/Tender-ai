'use strict';

// Reference only: call after server-side schema/provenance/rule validation.
// Never accept validation_state / eligible_for_decision from a browser or LLM.
// This module does not establish legal truth or the completeness of documents.
const REQUIRED_GATES = Object.freeze([
  'source_manifest', 'reading_general', 'reading_spec', 'reading_requirements',
  'legal', 'procedure', 'participant', 'product', 'supplier', 'economics', 'funding'
]);
const STATES = new Set(['pass', 'fail', 'unknown', 'not_applicable', 'conditional']);
const COVERAGE_STATES = new Set(['complete', 'partial', 'unknown', 'failed']);
const isDate = v => typeof v === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));

function evaluateReport(report, options) {
  const now = options?.now;
  if (!isDate(now)) throw new TypeError('now requires an ISO datetime with timezone');
  if (!report || !Array.isArray(report.checks) || !Array.isArray(report.evidence)
      || !report.snapshot || typeof report.snapshot.input_revision !== 'string'
      || !report.snapshot.input_revision || !options.currentInputRevision) {
    throw new TypeError('validated report and currentInputRevision required');
  }
  const issues = [];
  const evidence = new Map();
  const duplicateEvidence = new Set();
  for (const e of report.evidence) {
    if (evidence.has(e.id)) duplicateEvidence.add(e.id);
    evidence.set(e.id, e);
  }
  const byGate = new Map();
  const duplicateGates = new Set();
  for (const c of report.checks) {
    if (byGate.has(c.gate)) duplicateGates.add(c.gate);
    byGate.set(c.gate, c);
  }
  let stale = report.snapshot.input_revision !== options.currentInputRevision;
  if (!isDate(report.snapshot.as_of) || Date.parse(report.snapshot.as_of) > Date.parse(now)) {
    issues.push('invalid_snapshot_time');
  }
  if (stale) issues.push('input_revision_changed');
  for (const gate of duplicateGates) issues.push(`duplicate_gate:${gate}`);
  for (const id of duplicateEvidence) issues.push(`duplicate_evidence:${id}`);

  function trusted(c) {
    if (!c || c.validation_state !== 'verified' || !STATES.has(c.status)
        || duplicateGates.has(c.gate) || !Array.isArray(c.evidence_ids)
        || !c.evidence_ids.length || typeof c.rationale !== 'string' || !c.rationale.trim()) return false;
    if (!isDate(c.checked_at) || Date.parse(c.checked_at) > Date.parse(now)) return false;
    if (c.valid_until != null) {
      if (!isDate(c.valid_until)) return false;
      if (Date.parse(c.valid_until) <= Date.parse(now)) {
        stale = true; issues.push(`expired_check:${c.gate}`); return false;
      }
    }
    return c.evidence_ids.every(id => {
      const e = evidence.get(id);
      if (!e || duplicateEvidence.has(id) || e.citation_verified !== true
          || e.eligible_for_decision !== true || !e.source_id || !e.locator
          || !isDate(e.checked_at) || Date.parse(e.checked_at) > Date.parse(now)) return false;
      if (e.valid_until != null) {
        if (!isDate(e.valid_until)) return false;
        if (Date.parse(e.valid_until) <= Date.parse(now)) {
          stale = true; issues.push(`expired_evidence:${id}`); return false;
        }
      }
      return true;
    });
  }

  const normalized = REQUIRED_GATES.map(gate => {
    const c = byGate.get(gate);
    if (!c) { issues.push(`missing_gate:${gate}`); return { gate, status: 'unknown' }; }
    if (c.status === 'unknown') return { ...c, status: 'unknown' };
    if (!trusted(c)) { issues.push(`unverified_gate:${gate}`); return { ...c, status: 'unknown' }; }
    if (c.status === 'not_applicable' && !c.applicability_reason?.trim()) {
      issues.push(`missing_applicability:${gate}`); return { ...c, status: 'unknown' };
    }
    if (c.status === 'conditional' && (!Array.isArray(c.conditions) || !c.conditions.length
        || c.conditions.some(x => typeof x !== 'string' || !x.trim()))) {
      issues.push(`missing_conditions:${gate}`); return { ...c, status: 'unknown' };
    }
    return c;
  });
  const coverage = report.coverage || {};
  const paths = ['general', 'specification', 'bid_requirements'];
  const incomplete = paths.filter(k => coverage[k] !== 'complete');
  if (paths.some(k => !COVERAGE_STATES.has(coverage[k]))) issues.push('invalid_coverage');
  const manifestKnown = report.source_manifest?.expected_set_known === true;
  if (!manifestKnown) issues.push('primary_manifest_unknown');
  const unknown = normalized.filter(c => c.status === 'unknown').map(c => c.gate);
  const failures = normalized.filter(c => c.status === 'fail');
  const hardStops = failures.filter(c => c.hard_stop === true).map(c => c.gate);
  const conditional = normalized.filter(c => c.status === 'conditional').map(c => c.gate);
  // Unknowns must not be converted to ordinary reservations. A verified hard stop
  // can be shown even when unrelated source coverage is incomplete.
  let recommendation = 'insufficient_data';
  const invalid = issues.some(x => /^(invalid_|duplicate_)/.test(x));
  if (!stale && !invalid && hardStops.length) recommendation = 'do_not_participate';
  else if (!stale && !invalid && !unknown.length && !incomplete.length && manifestKnown) {
    if (failures.length) recommendation = 'insufficient_data';
    else recommendation = conditional.length ? 'participate_with_conditions' : 'participate';
  }
  return {
    recommendation,
    freshness: stale ? 'stale' : 'current',
    analysis_status: !invalid && manifestKnown && !incomplete.length ? 'complete' : 'partial',
    decision_status: recommendation === 'insufficient_data' ? 'provisional' : 'evaluated',
    unknown_gates: unknown,
    hard_stops: hardStops,
    conditional_gates: conditional,
    incomplete_paths: incomplete,
    issues: [...new Set(issues)],
    // Never create submission readiness here. Keep independent upstream results.
    bid_package_status: report.application?.package_status || 'needs_input'
  };
}
module.exports = { evaluateReport, REQUIRED_GATES };
