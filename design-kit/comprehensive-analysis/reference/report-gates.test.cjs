'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateReport, REQUIRED_GATES } = require('./report-gates.cjs');
const NOW = '2026-10-19T19:17:10+03:00';
const opts = { now: NOW, currentInputRevision: 'fixture-v1' };
// Synthetic fixture only; these are not actual legal/price confirmations.
function complete() {
  return {
    snapshot: { input_revision: 'fixture-v1', as_of: NOW },
    source_manifest: { expected_set_known: true },
    coverage: { general: 'complete', specification: 'complete', bid_requirements: 'complete' },
    evidence: [{ id: 'e1', source_id: 'synthetic', locator: 'test:1', citation_verified: true,
      eligible_for_decision: true, checked_at: NOW, valid_until: null }],
    checks: REQUIRED_GATES.map(gate => ({ gate, status: 'pass', validation_state: 'verified',
      rationale: 'Synthetic successful server check', evidence_ids: ['e1'], checked_at: NOW,
      valid_until: null, hard_stop: false, applicability_reason: null, conditions: [] })),
    application: { package_status: 'draft' }
  };
}
const set = (r, gate, changes) => Object.assign(r.checks.find(c => c.gate === gate), changes);
test('complete input permits recommendation but does not claim application sent', () => {
  const d=evaluateReport(complete(),opts); assert.equal(d.recommendation,'participate');
  assert.equal(d.bid_package_status,'draft'); assert.equal(d.analysis_status,'complete');
});
test('each missing required gate prevents a positive recommendation', () => {
  for(const gate of REQUIRED_GATES){const r=complete();r.checks=r.checks.filter(c=>c.gate!==gate);
    assert.equal(evaluateReport(r,opts).recommendation,'insufficient_data',gate);}
});
test('unknown supplier is not a reservation', () => {
  const r=complete();set(r,'supplier',{status:'unknown'});
  assert.equal(evaluateReport(r,opts).recommendation,'insufficient_data');
});
test('each extraction path is independent', () => {
  for(const k of ['general','specification','bid_requirements']){const r=complete();r.coverage[k]='partial';
    assert.equal(evaluateReport(r,opts).recommendation,'insufficient_data',k);}
});
test('complete uploaded files cannot prove an unknown primary manifest', () => {
  const r=complete();r.source_manifest.expected_set_known=false;
  assert.equal(evaluateReport(r,opts).recommendation,'insufficient_data');
});
test('verified hard stop remains visible with partial unrelated reading', () => {
  const r=complete();r.coverage.specification='partial';set(r,'procedure',{status:'fail',hard_stop:true});
  const d=evaluateReport(r,opts);assert.equal(d.recommendation,'do_not_participate');assert.equal(d.analysis_status,'partial');
});
test('unverified hard stop cannot justify a negative verdict', () => {
  const r=complete();set(r,'product',{status:'fail',hard_stop:true,validation_state:'unverified'});
  assert.equal(evaluateReport(r,opts).recommendation,'insufficient_data');
});
test('known bounded conditions can yield conditional participation', () => {
  const r=complete();set(r,'legal',{status:'conditional',conditions:['Verified condition in synthetic fixture']});
  assert.equal(evaluateReport(r,opts).recommendation,'participate_with_conditions');
});
test('conditional without an explicit condition remains unknown', () => {
  const r=complete();set(r,'legal',{status:'conditional'});
  assert.equal(evaluateReport(r,opts).recommendation,'insufficient_data');
});
test('not applicable must have a proven applicability reason', () => {
  const r=complete();set(r,'participant',{status:'not_applicable'});
  assert.equal(evaluateReport(r,opts).recommendation,'insufficient_data');
  set(r,'participant',{applicability_reason:'Synthetic exemption verified upstream'});
  assert.equal(evaluateReport(r,opts).recommendation,'participate');
});
test('expired quotation invalidates without source edits', () => {
  const r=complete();set(r,'supplier',{valid_until:'2026-10-19T10:00:00+03:00'});
  const d=evaluateReport(r,opts);assert.equal(d.freshness,'stale');assert.equal(d.recommendation,'insufficient_data');
});
test('expiry at exactly now is no longer current', () => {
  const r=complete();r.evidence[0].valid_until=NOW;
  assert.equal(evaluateReport(r,opts).freshness,'stale');
});
test('changed revision prevents old positive or negative recommendations', () => {
  for(const fail of [false,true]){const r=complete();if(fail)set(r,'legal',{status:'fail',hard_stop:true});
    assert.equal(evaluateReport(r,{...opts,currentInputRevision:'v2'}).recommendation,'insufficient_data');}
});
test('secondary evidence that only verifies a quotation is not decision evidence', () => {
  const r=complete();r.evidence[0].eligible_for_decision=false;
  assert.equal(evaluateReport(r,opts).recommendation,'insufficient_data');
});
test('nonexistent evidence fails closed', () => {
  const r=complete();set(r,'product',{evidence_ids:['made-up']});
  assert.equal(evaluateReport(r,opts).recommendation,'insufficient_data');
});
test('duplicate gates cannot hide a contradiction', () => {
  const r=complete();r.checks.push({...r.checks[0],status:'fail',hard_stop:true});
  assert.equal(evaluateReport(r,opts).recommendation,'insufficient_data');
});
test('duplicate evidence cannot silently replace proof', () => {
  const r=complete();r.evidence.push({...r.evidence[0]});
  assert.equal(evaluateReport(r,opts).recommendation,'insufficient_data');
});
test('invalid date, future check and unknown status cannot pass', () => {
  for(const delta of [{valid_until:'yesterday'},{checked_at:'2027-01-01T00:00:00Z'},{status:'green'}]){
    const r=complete();set(r,'supplier',delta);assert.equal(evaluateReport(r,opts).recommendation,'insufficient_data');}
});
test('future snapshot cannot give a current recommendation', () => {
  const r=complete();r.snapshot.as_of='2027-01-01T00:00:00Z';
  assert.equal(evaluateReport(r,opts).recommendation,'insufficient_data');
});
test('no timezone or missing inputs raises a contract error', () => {
  assert.throws(()=>evaluateReport(complete(),{...opts,now:'2026-10-19'}),TypeError);
  assert.throws(()=>evaluateReport({},opts),TypeError);
});
test('reference purchase remains insufficient rather than falsely profitable', () => {
  const r=require('../examples/report-0342100024526000062.json');
  const d=evaluateReport(r,{now:NOW,currentInputRevision:r.snapshot.input_revision});
  assert.equal(d.recommendation,'insufficient_data');
  assert.equal(r.commercial.net_profit_minor,null);
  assert.equal(r.application.package_status,'needs_input');
});
